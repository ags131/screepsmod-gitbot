const YAML = require('yamljs')
const express = require('express')
const crypto = require('crypto')
const request = require('request-promise')

const authroute = require(path.join(path.dirname(require.main.filename), '../lib/game/api/auth'))

const router = new express.Router()

let db, env

module.exports = function(config){
  db = config.db
  config.backend.on('expressPreConfig', (app) => {
    app.use(router)
  })
  router.use('/gitbot', express.static(`${__dirname}/../static`))
  router.post('/api/gitbot/secret', authroute.tokenAuth, bodyParser.json(), ({ body: { secret }, user: { _id } }, res) => {
    db.users.update({ _id }, { $set: { gitbotSecret: secret }})
  })
  router.post('/api/github/webhook', getUser, bodyParser.json({ 
    verify(req, res, buf, encoding) {
      req.raw = buf      
    }
  }), (req, res) => {
    const sig = req.get('x-hub-signature')
    const { gitbotSecret } = req.user
    const hmac = crypto.createHmac('sha1', gitbotSecret)
    hmac.update(req.raw)
    const hash = 'sha1=' + hmac.digest('hex')
    if (sig != hash) throw new Error('Invalid Signature')
      
    switch(req.get('x-github-event')) {
      case 'pull_request':
        if(req.body.action == 'closed' && req.body.pull_request.merged) {
          deploy(req)
        }
    }
  })
}

function getUser(req, res, next) {
  let { username } = req.query
  if (!username) return next('No username supplied')
  db.users.findOne({ username })
    .then(user => {
      if (!user) return next('No user found')
      req.user = user
      next()
    })
    
}

function deploy(req) {
  const { user, body } = req
  let repo = body.base.repo.full_name
  let branch = body.base.ref
  if (branch != 'master') return
  request.get('https://api.github.com/repos/${repo}/contents')
    .then(contents => {
      let configFile = contents.find(file => file.name == '.gitbot.yaml')
      if (configFile) {
        return getConfig(configFile.url)
      }
      throw new Error('No Config')
    })
    .then(({ directory, branch, badge } = {}) => {
      return getCode(repo, directory)
        .then(modules => {
          let timestamp = new Date().getTime()
          db['users.code'].update({ user: user._id, branch }, { $set: { branch, modules, timestamp }}, { upsert: true })
          if (badge) {
            db.users.update({ _id: user._id }, { $set: { badge } })
          }
          res.end()
        })      
    })
    .catch(err => {})
}

function getCode(repo, directory) {
  request.get('https://api.github.com/repos/${directory}/contents')
    .then(files => Promise.all(files.filter((f) => f.type == 'file' ).map(file => request.get(file.url))))
    .then(files => {
      let ret = {}
      files.forEach(({ name, contents }) => {
        name = name.replace(/.js$/, '')
        contents = new Buffer(contents, 'base64')
        ret[name] = contents
      })
    })
}

function getConfig(configURL){
  return request.get(configURL)
    .then(res => {
      const yaml = new Buffer(res.contents, 'base64').toString()
      return YAML.parse(yaml)
    })
}