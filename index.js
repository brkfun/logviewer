var jsonfile = require('jsonfile');
var util = require('util');
var request = require('request');
var url = require('url');

var express = require('express');
var compression = require('compression');
var cookieParser = require('cookie-parser');
var bodyParser = require('body-parser')
var app = express();
var server = require('http').Server(app);
var io = require('socket.io')(server);
var messagecompressor = require('./messagecompressor');
server.listen(8080);


// Middleware
app.use(compression());
app.set('view engine', 'jade');
app.use('/static', express.static("./html"));
app.use(cookieParser());
app.use(bodyParser.json()); // for parsing application/json
app.use(bodyParser.urlencoded({ extended: true })); // for parsing application/x-www-form-urlencoded
// no need for a database for settings, its all direct accesses anyways.
var settings = require('./settings.json');
var databaseconnector = require("./db/"+settings.database.type);
var db = new databaseconnector(settings.database);
var lvbot = require("./bot");
var bot = new lvbot(settings, db);
function absMax(){
	var best=0;
	for(var i=0;i<arguments.length;++i){
		if(Math.abs(best) < Math.abs(arguments[i])) best = arguments[i];
	}
	return best;
}

function getUserLevel(channel,name,callback) {
	var reslvl = null;
	var templvl = 0;
	if(bot.userlevels[channel] && bot.userlevels[channel][name]) templvl = bot.userlevels[channel][name];
	if(channel == name) templvl = 10;
	db.getUserLevel(channel, name, function(lv){
		if(reslvl === null) {
			reslvl = lv;
		} else {
			callback(absMax(1,reslvl,lv,templvl));
		}
	});
	db.getUserLevel("logviewer", name, function(lv){
		if(reslvl === null) {
			reslvl = lv;
		} else {
			callback(absMax(1,reslvl,lv,templvl));
		}
	});
}	

// currently unused
function setUserLevel(channel, user, level, save) {
	if(userlevels[channel] === undefined) userlevels[channel] = {};
	bot.userlevels[channel][user] = level;
	if(save) db.setUserLevel(channel, user, level);
}


// HTTP server routes 'n shit
function checkAuth(req, res, callback) {
	var user = req.cookies.login;
	var token = req.cookies.token;
	if(user !== undefined && token !== undefined) {
		db.checkAndRefreshToken(user, token, ~~(Date.now()/1000)+32*24*3600, function(ok){
			if(ok) {
				res.cookie('token',token,{ maxAge: 32*24*3600000 });
				res.cookie('login',user,{ maxAge: 32*24*3600000 });
			} else {
				res.clearCookie('token');
				res.clearCookie('login');
			}
			if(callback)callback(ok);
		});
	} else {
		callback(false);
	}
}

function getLevel(channel, token, callback) {
	db.getAuthUser(token, function(name){
		if(name) {
			getUserLevel(channel,name,function(level){
				callback(level,name);
			});
		} else callback(0,null);
	});
}

function generateToken(res, username, callback) {
	require('crypto').randomBytes(32, function(err, buffer) {
		var token = buffer.toString("hex");
		db.storeToken(username, token, ~~(Date.now()/1000)+32*24*3600);
		res.cookie('token',token,{ maxAge: 32*24*3600000 });
		res.cookie('login',username,{ maxAge: 32*24*3600000 });
		callback();
	});
}

app.get('/', function(req, res, next) {
	try {
		checkAuth(req, res, function(){
			res.sendFile(__dirname + '/html/index.html');
		});
	} 
	catch(err) {
		next(err);
	}
});

app.get('/api',function(req,res,next) {
	try {
		if(req.query.token){
			db.getAuthUser(req.query.token, function(name){
				if(name){
					res.jsonp({
						name: name,
						valid: true,
						auth: {
							client_id: settings.auth.client_id,
							baseurl: settings.auth.baseurl
						}
					});
				}
				else res.status(404).jsonp({
					name: null,
					valid: false,
					auth: {
						client_id: settings.auth.client_id,
						baseurl: settings.auth.baseurl
					}
				});
			});
		} else {
			res.jsonp({
				name: null,
				valid: false,
				auth: {
					client_id: settings.auth.client_id,
					baseurl: settings.auth.baseurl
				}
			});
		}
	}
	catch(err) {
		next(err);
	}
});

app.get('/:channel', function(req, res, next) {
	try {
		checkAuth(req, res, function(){
			res.sendFile(__dirname + '/html/index.html');
		});
	} 
	catch(err) {
		next(err);
	}
});
app.get('/:channel/settings', function(req, res, next) {
	try {
		checkAuth(req, res, function(){
			res.sendFile(__dirname + '/html/index.html');
		});
	} 
	catch(err) {
		next(err);
	}
});



app.get('/api/login', function(req, res, next) {
	try {
		var getToken = function(err,httpResponse,body) {
			console.log(body);
			var token = JSON.parse(body).access_token;
			request.get({
				url: "https://api.twitch.tv/kraken/?oauth_token="+token+"&client_id="+settings.auth.client_id
			},function(e,r,body2){
				console.log("Token response: "+body2);
				if(body2 === undefined) {
					console.log("Error: "+httpResponse.statusCode);
					getToken(err,httpResponse,body);
				} else {
					var auth = JSON.parse(body2).token;
					if(auth.valid) {
						generateToken(res, auth.user_name, function(){
							res.redirect(url.parse(req.query.state).path);
						});
					} else {
						res.status(500).end("Invalid token");
					}
				}
			});
		}
		request.post({
				url: 'https://api.twitch.tv/kraken/oauth2/token',
				form: {
					client_id: settings.auth.client_id,
					client_secret: settings.auth.client_secret,
					grant_type: "authorization_code",
					redirect_uri: settings.auth.baseurl + "/api/login",
					code: req.query.code,
					state: req.query.state
				}
			},
			getToken
		);
	} 
	catch(err) {
		next(err);
	}
});

app.get('/api/logout',function(req,res,next) {
	try {
		if(req.query.token === req.cookies.token) {
			db.deleteToken(req.query.token);
			res.clearCookie('token');
			res.clearCookie('login');
			res.status(200).end();
		} else {
			res.status(400).jsonp({"error":"Missing, mismatching or invalid token"});
		}
	} 
	catch(err) {
		next(err);
	}
});

app.get('/api/channel/:channel', function(req, res, next) {
	try {
		var channel = req.params.channel.toLowerCase();
		db.getChannel(channel, function(channelObj) {
			if(!channelObj)
			{
				getLevel(channel, req.query.token, function(level, user){
					res.jsonp({"channel":null,"me":{name:user, level:level, valid: !!user}});
				});
				return;
			}
			getLevel(channelObj.name, req.query.token, function(level, user){
				res.jsonp({"channel":channelObj,"me":{name:user, level:level, valid: !!user}});
			});
		});
	} 
	catch(err) {
		next(err);
	}
});

app.get('/api/channels', function(req, res, next) {
	try {
		db.getChannels(function(r) {
			res.jsonp(r);
		});
	} 
	catch(err) {
		next(err);
	}
});


function isNormalInteger(str) {
	var n = ~~Number(str);
	return String(n) === str && n >= 0;
}

function getLogs(channel, query, callback) {
	if(query.id) { 
		var id = parseInt(query.id);
		db.getLogsById(channel, id, query.nick, Math.min(parseInt(query.before || 10),100), Math.min(parseInt(query.after || 10),100), function(before, after){
			for(var i=0;i<before.length;++i) {
				before[i].text = messagecompressor.decompressMessage("#"+channel, before[i].nick, before[i].text);
			}
			for(var i=0;i<after.length;++i) {
				after[i].text = messagecompressor.decompressMessage("#"+channel, after[i].nick, after[i].text);
			}
			if(query.nick) {
				db.getUserStats(channel, query.nick, function(userobj) {
					callback({id:id, user: userobj, before: before, after: after});
				});
			}
			else {
				callback({id:id, before: before, after: after});
			}
		});
	}
	else if(query.nick) {
		db.getLogsByNick(channel, query.nick, Math.min(parseInt(query.before || 10), 100), function(before){
			for(var i=0;i<before.length;++i) {
				before[i].text = messagecompressor.decompressMessage("#"+channel, before[i].nick, before[i].text);
			}
			db.getUserStats(channel, query.nick, function(userobj) {
				callback({id:id, user: userobj, before: before, after: []});
			});
		});
	}
	else 
	{
		callback({"error":"Missing both parameters nick and id."});
	}
}

app.get('/api/logs/:channel', function(req, res, next) {
	try {
		var channel = req.params.channel.toLowerCase();
		db.getActiveChannel(channel, function(channelObj) {
			if(!channelObj)
			{
				res.status(404).jsonp({"error":"Channel "+channel+" not found."});
				return;
			}
			if(channelObj.viewlogs > 0) {
				getLevel(channelObj.name, req.query.token, function(level){
					if(level >= channelObj.viewlogs) {
						getLogs(channelObj.name, req.query, function(logs){
							res.jsonp(logs);
						});
					} else {
						res.status(403).end();
					}
				});
			} else {
				getLogs(channelObj.name, req.query, function(logs){
					res.jsonp(logs);
				});
			}
		});
	} 
	catch(err) {
		next(err);
	}
});
var allowedsettings = ["active","viewlogs","viewcomments","writecomments","deletecomments"];
app.post('/api/settings/:channel', function(req, res, next) {
	try {
		var channel = req.params.channel.toLowerCase();
		db.getChannel(channel, function(channelObj) {
			if(!channelObj)
			{
				// add a new channel
				getLevel(channel, req.body.token, function(level){
					if(level >= 10) {
						db.addChannel(channel, function() {
							var newsettings = req.body.settings;
							for(var i=0;i<allowedsettings.length;++i) {
								var key = allowedsettings[i];
								if(!isNaN(parseInt(newsettings[key]))) {
									db.setSetting(channel, key, newsettings[key]);
								}
								res.status(200).end();
								if(key === "active") {
									if(newsettings.active == "1") bot.joinChannel(channel);
									else bot.partChannel(channel);
								}
							}
						});
					} else {
						res.status(403).end();
					}
				});
			} else {
				getLevel(channelObj.name, req.body.token, function(level){
					if(level >= 10) {
						var newsettings = req.body.settings;
						for(var i=0;i<allowedsettings.length;++i) {
							var key = allowedsettings[i];
							if(!isNaN(parseInt(newsettings[key]))) {
								db.setSetting(channelObj.name, key, newsettings[key]);
							}
							res.status(200).end();
							if(key === "active") {
								if(newsettings.active == "1") bot.joinChannel(channelObj.name);
								else bot.partChannel(channelObj.name);
							}
						}
					} else {
						res.status(403).end();
					}
				});
			}
		});
	} 
	catch(err) {
		next(err);
	}
});

app.get('/api/levels/:channel',function(req,res,next){
	try {
		var channel = req.params.channel.toLowerCase();
		db.getChannel(channel, function(channelObj) {
			if(!channelObj)
			{
				res.status(404).jsonp({"error":"Channel "+channel+" not found."});
				return;
			}
			getLevel(channelObj.name, req.query.token, function(level){
				if(level >= 10) {
					db.getLevels(channelObj.name,function(levels) {
						res.jsonp(levels);
					});
				} else {
					res.status(403).end();
				}
			});
		});
	} 
	catch(err) {
		next(err);
	}
});

app.post('/api/levels/:channel',function(req,res,next){
	try {
		var channel = req.params.channel.toLowerCase();
		db.getChannel(channel, function(channelObj) {
			if(!channelObj)
			{
				res.status(404).jsonp({"error":"Channel "+channel+" not found."});
				return;
			}
			getLevel(channelObj.name, req.body.token, function(level){
				if(level >= 10) {
					var newlevels = req.body.levels;
					for(var i=0;i<newlevels.length;++i) {
						var userObject = newlevels[i];
						if(Math.abs(userObject.level) <= level && /^\w+$/.test(userObject.nick)) {
							db.setLevel(channelObj.name,userObject.nick.toLowerCase(),userObject.level);
						}
					}
					res.status(200).end();
				} else {
					res.status(403).end();
				}
			});
		});
	}
	catch(err) {
		next(err);
	}
	
});

// comments
app.get('/api/comments/:channel', function(req,res,next){
	try {
		var channel = req.params.channel.toLowerCase();
		db.getActiveChannel(channel, function(channelObj) {
			if(!channelObj)
			{
				res.status(404).jsonp({"error":"Channel "+channel+" not found."});
				return;
			}
			getLevel(channelObj.name, req.query.token, function(level){
				if(level >= channelObj.viewcomments) {
					db.getComments(channelObj.name,req.query.topic,function(comments) {
						res.jsonp(comments || []);
					});
				} else {
					res.status(403).end();
				}
			});
		});
	} 
	catch(err) {
		next(err);
	}
});

app.post('/api/comments/:channel',function(req,res,next){
	try {
		var channel = req.params.channel.toLowerCase();
		db.getChannel(channel, function(channelObj) {
			if(!channelObj)
			{
				res.status(404).jsonp({"error":"Channel "+channel+" not found."});
				return;
			}
			var newsettings = req.body;
			getLevel(channelObj.name, newsettings.token, function(level, nick){
				if(newsettings.id) {
					// we are editing a comment
					db.getComment(channelObj.name, newsettings.id, function(comment){
						if(comment) {
							// only people with the edit permission can delete other peoples comments
							if(level >= channelObj.editcomments || comment.author == nick) {
								db.updateComment(channelObj.name, newsettings.id, newsettings.text);
								res.status(200).end();
							} else {
								res.status(403).jsonp({"error":"Can only edit own comments"});
								return;
							}
						} else {
							res.status(404).jsonp({"error":"Comment not found"});
						}
					});
				} else {
					if(newsettings.topic === undefined) {
						res.status(400).jsonp({"error":"Missing parameter topic."});
					} else if(newsettings.text === undefined) {
						res.status(400).jsonp({"error":"Missing parameter text."});
					} else if(level >= channelObj.writecomments) {
						db.addComment(channelObj.name,nick,newsettings.topic, newsettings.text);
						res.status(200).end();
					} else {
						res.status(403).jsonp({"error":"Cannot write comments for this channel"});
						return;
					}
				}
			});
		});
	}
	catch(err) {
		next(err);
	}
	
});

app.delete('/api/comments/:channel',function(req,res,next){
	try {
		var channel = req.params.channel.toLowerCase();
		db.getChannel(channel, function(channelObj) {
			if(!channelObj)
			{
				res.status(404).jsonp({"error":"Channel "+channel+" not found."});
				return;
			}
			if(req.query.id === undefined) {
				res.status(400).jsonp({"error":"Missing parameter id."});
			} else {
				getLevel(channelObj.name, req.query.token, function(level, nick){
					db.getComment(channelObj.name, req.query.id, function(comment){
						if(!comment) {
							res.status(404).jsonp({"error":"Comment not found"});
							return;
						}
						// only people with the deletion permission can delete other peoples comments
						if(level >= channelObj.deletecomments || comment.author == nick) { 
							db.deleteComment(channelObj.name, req.query.id);
							res.status(200).end();
							return;
						} else {
							res.status(403).jsonp({"error":"Can only delete own comments"});
							return;
						}
					});
				});
			}
			
		});
	}
	catch(err) {
		next(err);
	}
	
});


app.use(function(err, req, res, next) {
	res.status(err.status || 500);
	res.send("<pre>"+err.stack+"\r\n"+err.message+"</pre>");
	console.log(err);
});