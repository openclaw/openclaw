require('dotenv').config();
const express = require('express');
const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Hewlett121212$';
const ADMIN_RECOVERY_ANSWER = 'bouwer';
const OPENCLAW_IMAGE = process.env.OPENCLAW_IMAGE || 'ghcr.io/openclaw/openclaw:latest';
const BASE_GATEWAY_PORT = parseInt(process.env.BASE_GATEWAY_PORT) || 19000;
const OPENCLAW_DATA_BASE = process.env.OPENCLAW_DATA_BASE || path.join(__dirname, 'data');

const CODES_FILE = path.join(__dirname, 'codes.json');
const INSTANCES_FILE = path.join(__dirname, 'instances.json');
const ENROLLMENTS_FILE = path.join(__dirname, 'enrollments.json');
const ADMINS_FILE = path.join(__dirname, 'admins.json');
const APPROVE_SECRET = process.env.APPROVE_SECRET || 'sclaw-approve-7x9k';

// ---- CLIENT AUTH ----
function hashClientPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}
function verifyClientPassword(password, stored) {
  try {
    const [salt, hash] = stored.split(':');
    return crypto.scryptSync(password, salt, 32).toString('hex') === hash;
  } catch { return false; }
}
const clientSessions = new Map(); // token -> { agentName, containerName, email, expiresAt }
function createClientSession(instance) {
  const token = crypto.randomBytes(32).toString('hex');
  clientSessions.set(token, {
    agentName: instance.agentName,
    containerName: instance.containerName,
    email: instance.clientEmail,
    displayName: instance.displayName || instance.agentName,
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000
  });
  return token;
}
function clientAuth(req, res, next) {
  const token = req.headers['x-client-token'];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  const session = clientSessions.get(token);
  if (!session || session.expiresAt < Date.now()) return res.status(401).json({ error: 'Session expired' });
  req.clientSession = session;
  next();
}

function loadCodes() {
  return JSON.parse(fs.readFileSync(CODES_FILE, 'utf8'));
}
function saveCodes(codes) {
  fs.writeFileSync(CODES_FILE, JSON.stringify(codes, null, 2));
}
function loadInstances() {
  return JSON.parse(fs.readFileSync(INSTANCES_FILE, 'utf8'));
}
function saveInstances(instances) {
  fs.writeFileSync(INSTANCES_FILE, JSON.stringify(instances, null, 2));
}
function loadEnrollments() {
  try { return JSON.parse(fs.readFileSync(ENROLLMENTS_FILE, 'utf8')); } catch { return []; }
}
function saveEnrollments(list) {
  fs.writeFileSync(ENROLLMENTS_FILE, JSON.stringify(list, null, 2));
}
function loadAdmins() {
  try { return JSON.parse(fs.readFileSync(ADMINS_FILE, 'utf8')); } catch { return []; }
}
function saveAdmins(list) {
  fs.writeFileSync(ADMINS_FILE, JSON.stringify(list, null, 2));
}
function generateCode(prefix = 'SUPERCLAW') {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return `${prefix}-${code}`;
}

function getNextPort() {
  const instances = loadInstances();
  if (instances.length === 0) return BASE_GATEWAY_PORT;
  const usedPorts = instances.map(i => i.gatewayPort);
  let port = BASE_GATEWAY_PORT;
  while (usedPorts.includes(port)) port += 2;
  return port;
}

// Resolve caller role: 'master', 'maintenance', or null
function resolveRole(password) {
  if (!password) return null;
  if (password === ADMIN_PASSWORD) return 'master'; // super password always wins
  const admins = loadAdmins();
  const match = admins.find(a => a.password === password);
  return match ? match.role : null;
}

// Any valid admin (master or maintenance)
function adminAuth(req, res, next) {
  const role = resolveRole(req.headers['x-admin-password']);
  if (!role) return res.status(401).json({ error: 'Unauthorized' });
  req.adminRole = role;
  next();
}

// Master-only routes
function masterAuth(req, res, next) {
  const role = resolveRole(req.headers['x-admin-password']);
  if (role !== 'master') return res.status(403).json({ error: 'Master access required' });
  req.adminRole = 'master';
  next();
}

// POST /api/admin/login — returns role so UI can adapt
app.post('/api/admin/login', (req, res) => {
  const role = resolveRole(req.body.password);
  if (role) {
    const admins = loadAdmins();
    const match = admins.find(a => a.password === req.body.password);
    const name = match ? match.name : 'Master';
    res.json({ success: true, role, name });
  } else {
    res.status(401).json({ error: 'Wrong password' });
  }
});

// POST /api/admin/recover — password recovery via security question
app.post('/api/admin/recover', (req, res) => {
  const { answer } = req.body;
  if (answer && answer.trim().toLowerCase() === ADMIN_RECOVERY_ANSWER) {
    res.json({ success: true, password: ADMIN_PASSWORD });
  } else {
    res.status(401).json({ error: 'Incorrect answer' });
  }
});

// GET /api/admin/containers — live Docker container status
app.get('/api/admin/containers', adminAuth, (req, res) => {
  try {
    const raw = execSync(`docker ps -a --filter "name=superclaw-" --filter "name=wa-sender-" --filter "name=friday-" --filter "ancestor=openclaw-chrome:latest" --filter "ancestor=ghcr.io/openclaw/openclaw:latest" --format '{{json .}}'`).toString().trim();
    const containers = raw ? raw.split('\n').map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean).map(c => ({
      name: c.Names,
      image: c.Image,
      status: c.Status,
      state: c.State,
      ports: c.Ports,
      created: c.CreatedAt,
      id: c.ID
    })) : [];
    res.json(containers);
  } catch (e) {
    res.json([]);
  }
});

// POST /api/admin/restart/:name — maintenance allowed
app.post('/api/admin/restart/:name', adminAuth, (req, res) => {
  try {
    execSync(`docker restart ${req.params.name}`, { timeout: 30000 });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/stop/:name — maintenance allowed
app.post('/api/admin/stop/:name', adminAuth, (req, res) => {
  try {
    execSync(`docker stop ${req.params.name}`, { timeout: 30000 });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/admin/start/:name — maintenance allowed
app.post('/api/admin/start/:name', adminAuth, (req, res) => {
  try {
    execSync(`docker start ${req.params.name}`, { timeout: 30000 });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/admin/delete/:name — full teardown (master only)
app.delete('/api/admin/delete/:name', masterAuth, (req, res) => {
  const name = req.params.name;
  try {
    // Determine agent name from container name
    const agentName = name.replace('superclaw-', '');
    // Stop and remove main container
    try { execSync(`docker rm -f ${name} 2>/dev/null`); } catch {}
    // Stop and remove wa-sender
    try { execSync(`docker rm -f wa-sender-${agentName} 2>/dev/null`); } catch {}
    // Remove volumes
    try { execSync(`docker volume rm ${agentName}_openclaw-data wa-sender-${agentName}-data 2>/dev/null`); } catch {}
    // Remove directory
    const agentDir = path.join('/opt/superclaw/agents', agentName);
    if (fs.existsSync(agentDir)) {
      execSync(`rm -rf "${agentDir}"`);
    }
    // Remove from instances list
    try {
      const instances = loadInstances();
      const filtered = instances.filter(i => i.containerName !== name && i.id !== agentName);
      saveInstances(filtered);
    } catch {}
    res.json({ success: true, message: `Agent ${agentName} fully removed` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/admin/logs/:name
app.get('/api/admin/logs/:name', adminAuth, (req, res) => {
  try {
    const lines = req.query.lines || 100;
    const logs = execSync(`docker logs --tail ${lines} ${req.params.name} 2>&1`, { timeout: 10000 }).toString();
    res.json({ logs });
  } catch (e) {
    res.json({ logs: e.message });
  }
});

// GET /api/admin/server-stats
app.get('/api/admin/server-stats', adminAuth, (req, res) => {
  try {
    const disk = execSync(`df -h / --output=size,used,avail,pcent | tail -1`).toString().trim().split(/\s+/);
    const mem = execSync(`free -m | grep Mem`).toString().trim().split(/\s+/);
    const uptime = execSync(`uptime -p`).toString().trim();
    const containers = execSync(`docker ps -q | wc -l`).toString().trim();
    res.json({
      disk: { total: disk[0], used: disk[1], free: disk[2], percent: disk[3] },
      memory: { total: mem[1] + 'MB', used: mem[2] + 'MB', free: mem[3] + 'MB' },
      uptime,
      runningContainers: parseInt(containers) || 0
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// GET /api/admin/codes — master only
app.get('/api/admin/codes', masterAuth, (req, res) => {
  try { res.json(loadCodes()); } catch { res.json([]); }
});

// POST /api/admin/codes/bulk — generate multiple activation codes (master only)
app.post('/api/admin/codes/bulk', masterAuth, (req, res) => {
  const count = Math.min(parseInt(req.body.count) || 5, 50);
  const prefix = req.body.prefix || 'SUPERCLAW';
  const codes = loadCodes();
  const newCodes = [];
  for (let i = 0; i < count; i++) {
    const code = generateCode(prefix);
    codes.push({ code, used: false, createdAt: new Date().toISOString() });
    newCodes.push(code);
  }
  saveCodes(codes);
  res.json({ codes: newCodes });
});

// GET /api/admin/enrollments — list all enrollment requests
app.get('/api/admin/enrollments', adminAuth, (req, res) => {
  res.json(loadEnrollments());
});

// DELETE /api/admin/enrollments/:id — remove a single enrollment
app.delete('/api/admin/enrollments/:id', adminAuth, (req, res) => {
  const enrollments = loadEnrollments();
  const filtered = enrollments.filter(e => e.id !== req.params.id);
  if (filtered.length === enrollments.length) return res.status(404).json({ error: 'Not found' });
  saveEnrollments(filtered);
  res.json({ success: true, removed: req.params.id });
});

// ---- ADMIN TEAM MANAGEMENT (master only) ----

// GET /api/admin/admins — list all sub-admins
app.get('/api/admin/admins', masterAuth, (req, res) => {
  const admins = loadAdmins().map(a => ({ id: a.id, name: a.name, role: a.role, createdAt: a.createdAt }));
  res.json(admins); // never return passwords
});

// POST /api/admin/admins — create a sub-admin
app.post('/api/admin/admins', masterAuth, (req, res) => {
  const { name, password, role } = req.body;
  if (!name || !password || !['master', 'maintenance'].includes(role)) {
    return res.status(400).json({ error: 'name, password, and role (master/maintenance) required' });
  }
  const admins = loadAdmins();
  if (admins.find(a => a.password === password)) {
    return res.status(400).json({ error: 'That password is already in use' });
  }
  const newAdmin = { id: uuidv4().slice(0, 8), name, password, role, createdAt: new Date().toISOString() };
  admins.push(newAdmin);
  saveAdmins(admins);
  res.json({ success: true, id: newAdmin.id, name, role });
});

// DELETE /api/admin/admins/:id — remove a sub-admin
app.delete('/api/admin/admins/:id', masterAuth, (req, res) => {
  const admins = loadAdmins();
  const filtered = admins.filter(a => a.id !== req.params.id);
  if (filtered.length === admins.length) return res.status(404).json({ error: 'Not found' });
  saveAdmins(filtered);
  res.json({ success: true });
});

// POST /api/enroll — submit enrollment request (public, bot-protected)
app.post('/api/enroll', (req, res) => {
  const { firstName, lastName, email, phone, mathAnswer, formLoadedAt, website } = req.body;
  // Honeypot check — bots fill the hidden 'website' field
  if (website) return res.status(400).json({ error: 'Spam detected' });
  // Timing check — form must take >3 seconds to fill
  const elapsed = Date.now() - (formLoadedAt || 0);
  if (elapsed < 3000) return res.status(400).json({ error: 'Too fast, please try again' });
  // Math challenge check
  if (parseInt(mathAnswer) !== parseInt(req.body.mathExpected)) {
    return res.status(400).json({ error: 'Incorrect math answer' });
  }
  // Validate fields
  if (!firstName || !lastName || !email || !phone) {
    return res.status(400).json({ error: 'All fields are required' });
  }
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) return res.status(400).json({ error: 'Invalid email' });

  const id = uuidv4().slice(0, 8);
  const enrollment = {
    id, firstName, lastName, email, phone,
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  const enrollments = loadEnrollments();
  enrollments.push(enrollment);
  saveEnrollments(enrollments);

  // Send WhatsApp notification to Steven via Friday's gateway
  try {
    const approveUrl = `https://app.superclaw.global/api/enroll/approve/${id}?token=${APPROVE_SECRET}`;
    const rejectUrl = `https://app.superclaw.global/api/enroll/reject/${id}?token=${APPROVE_SECRET}`;
    const msg = `🦞 New Enrollment Request!\n\n` +
      `Name: ${firstName} ${lastName}\n` +
      `Email: ${email}\n` +
      `Phone: ${phone}\n` +
      `Time: ${new Date().toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' })}\n\n` +
      `✅ Approve: ${approveUrl}\n` +
      `❌ Reject: ${rejectUrl}`;
    fetch('http://127.0.0.1:3001/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer superclaw-wa-sender-2026' },
      body: JSON.stringify({ to: '27824430749', message: msg })
    }).catch(() => {});
  } catch {}

  res.json({ success: true, message: 'Request submitted! You will receive your code via email once approved.' });
});

// GET /api/enroll/approve/:id — one-click approval (from WhatsApp link)
app.get('/api/enroll/approve/:id', (req, res) => {
  if (req.query.token !== APPROVE_SECRET) return res.status(403).send('Forbidden');
  const enrollments = loadEnrollments();
  const enrollment = enrollments.find(e => e.id === req.params.id);
  if (!enrollment) return res.status(404).send('Enrollment not found');
  if (enrollment.status === 'approved') return res.send(`<h2>Already approved</h2><p>Code: ${enrollment.code}</p>`);

  // Generate activation code
  const code = generateCode('SUPERCLAW');
  const codes = loadCodes();
  codes.push({ code, used: false, createdAt: new Date().toISOString(), issuedTo: `${enrollment.firstName} ${enrollment.lastName}`, email: enrollment.email });
  saveCodes(codes);

  enrollment.status = 'approved';
  enrollment.code = code;
  enrollment.approvedAt = new Date().toISOString();
  saveEnrollments(enrollments);

  // Send approval WhatsApp notification to applicant (if they have WhatsApp)
  try {
    const phone = enrollment.phone.replace(/[^0-9]/g, '');
    const msg = `🦞 Welcome to Superclaw!\n\nYour activation code: *${code}*\n\nGo to https://app.superclaw.global/deploy.html and enter this code to deploy your AI agent.\n\n— Team Superclaw`;
    fetch('http://127.0.0.1:3001/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer superclaw-wa-sender-2026' },
      body: JSON.stringify({ to: phone, message: msg })
    }).catch(() => {});
  } catch {}

  res.send(`
    <html><head><title>Approved</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>body{font-family:Inter,sans-serif;background:#0a0e1a;color:#f0f2f5;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;}
    .box{background:rgba(17,24,39,0.9);border:1px solid rgba(16,185,129,0.3);border-radius:20px;padding:48px;max-width:420px;}
    h2{font-size:24px;margin-bottom:12px;} .code{font-size:28px;font-weight:800;color:#10b981;letter-spacing:3px;margin:16px 0;}
    p{color:#9ca3af;font-size:14px;}</style></head>
    <body><div class="box"><h2>✅ Approved!</h2>
    <p>${enrollment.firstName} ${enrollment.lastName}</p>
    <div class="code">${code}</div>
    <p>Code sent to ${enrollment.phone} via WhatsApp</p>
    <p style="margin-top:20px"><a href="/admin-dashboard.html" style="color:#8b5cf6">Back to Admin</a></p>
    </div></body></html>
  `);
});

// GET /api/enroll/reject/:id
app.get('/api/enroll/reject/:id', (req, res) => {
  if (req.query.token !== APPROVE_SECRET) return res.status(403).send('Forbidden');
  const enrollments = loadEnrollments();
  const enrollment = enrollments.find(e => e.id === req.params.id);
  if (!enrollment) return res.status(404).send('Not found');
  enrollment.status = 'rejected';
  enrollment.rejectedAt = new Date().toISOString();
  saveEnrollments(enrollments);
  res.send(`
    <html><head><title>Rejected</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>body{font-family:Inter,sans-serif;background:#0a0e1a;color:#f0f2f5;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;}
    .box{background:rgba(17,24,39,0.9);border:1px solid rgba(239,68,68,0.3);border-radius:20px;padding:48px;max-width:420px;}
    h2{font-size:24px;margin-bottom:12px;} p{color:#9ca3af;font-size:14px;}</style></head>
    <body><div class="box"><h2>❌ Rejected</h2>
    <p>${enrollment.firstName} ${enrollment.lastName}'s enrollment has been rejected.</p>
    <p style="margin-top:20px"><a href="/admin-dashboard.html" style="color:#8b5cf6">Back to Admin</a></p>
    </div></body></html>
  `);
});

// POST /api/activate — validate code and provision instance
app.post('/api/activate', (req, res) => {
  const { code, agentName } = req.body;
  if (!code) return res.status(400).json({ error: 'Activation code required' });

  const codes = loadCodes();
  const entry = codes.find(c => c.code.toUpperCase() === code.trim().toUpperCase());

  if (!entry) return res.status(404).json({ error: 'Invalid activation code' });
  if (entry.used) return res.status(400).json({ error: 'Code already used' });

  const instanceId = uuidv4();
  const gatewayPort = getNextPort();
  const bridgePort = gatewayPort + 1;
  const dataDir = path.join(OPENCLAW_DATA_BASE, instanceId);
  const name = agentName || 'Superclaw';
  const token = uuidv4().replace(/-/g, '');

  // Create data directory
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'workspace'), { recursive: true });

  // Write initial IDENTITY.md
  fs.writeFileSync(path.join(dataDir, 'workspace', 'IDENTITY.md'), 
    `# IDENTITY.md\n- **Name:** ${name}\n- **Vibe:** Helpful AI assistant\n`);

  const containerName = `friday-${instanceId.slice(0, 8)}`;

  // Start OpenClaw gateway container
  const cmd = [
    'docker', 'run', '-d',
    '--name', containerName,
    '--restart', 'unless-stopped',
    '-p', `${gatewayPort}:18789`,
    '-p', `${bridgePort}:18790`,
    '-v', `${dataDir}:/root/.openclaw`,
    '-e', `HOME=/root`,
    '-e', `OPENCLAW_GATEWAY_TOKEN=${token}`,
    OPENCLAW_IMAGE,
    'node', 'dist/index.js', 'gateway',
    '--bind', 'lan',
    '--port', '18789',
    '--allow-unconfigured'
  ].join(' ');

  try {
    execSync(cmd);

    // Mark code as used
    entry.used = true;
    entry.activatedBy = instanceId;
    entry.activatedAt = new Date().toISOString();
    saveCodes(codes);

    // Save instance
    const instance = {
      id: instanceId,
      code,
      agentName: name,
      containerName,
      gatewayPort,
      bridgePort,
      token,
      dataDir,
      status: 'starting',
      createdAt: new Date().toISOString(),
      whatsappLinked: false
    };
    const instances = loadInstances();
    instances.push(instance);
    saveInstances(instances);

    res.json({ 
      success: true, 
      instanceId, 
      gatewayPort,
      token,
      agentName: name,
      message: 'Agent starting. Waiting for WhatsApp QR code...'
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to start agent: ' + err.message });
  }
});

// GET /api/qr/:instanceId — poll for WhatsApp QR code
app.get('/api/qr/:instanceId', async (req, res) => {
  const instances = loadInstances();
  const instance = instances.find(i => i.id === req.params.instanceId);
  if (!instance) return res.status(404).json({ error: 'Instance not found' });

  try {
    // Fetch QR from OpenClaw gateway on the instance port
    const response = await fetch(`http://127.0.0.1:${instance.gatewayPort}/api/v1/channels/whatsapp/default/qr`);
    if (!response.ok) return res.json({ qr: null, status: 'waiting' });
    const data = await response.json();
    res.json({ qr: data.qr || null, status: data.qr ? 'ready' : 'waiting' });
  } catch {
    res.json({ qr: null, status: 'waiting' });
  }
});

// GET /api/status/:instanceId
app.get('/api/status/:instanceId', async (req, res) => {
  const instances = loadInstances();
  const instance = instances.find(i => i.id === req.params.instanceId);
  if (!instance) return res.status(404).json({ error: 'Not found' });

  try {
    const health = await fetch(`http://127.0.0.1:${instance.gatewayPort}/healthz`);
    const linked = await fetch(`http://127.0.0.1:${instance.gatewayPort}/api/v1/channels/whatsapp/default/status`, {
      headers: { 'Authorization': `Bearer ${instance.token}` }
    });
    const linkedData = linked.ok ? await linked.json() : {};
    res.json({ 
      ...instance, 
      gatewayHealthy: health.ok,
      whatsappLinked: linkedData.connected || false
    });
  } catch {
    res.json({ ...instance, gatewayHealthy: false });
  }
});

// ---- ADMIN ROUTES ----

// GET /api/admin/instances
app.get('/api/admin/instances', adminAuth, (req, res) => {
  const instances = loadInstances();
  res.json(instances);
});

// GET /api/admin/codes
app.get('/api/admin/codes', adminAuth, (req, res) => {
  res.json(loadCodes());
});

// POST /api/admin/codes — create new activation code
app.post('/api/admin/codes', adminAuth, (req, res) => {
  const { code } = req.body;
  const newCode = code || `SUPERCLAW-${Math.random().toString(36).slice(2,8).toUpperCase()}`;
  const codes = loadCodes();
  if (codes.find(c => c.code === newCode)) return res.status(400).json({ error: 'Code exists' });
  codes.push({ code: newCode, used: false, activatedBy: null, createdAt: new Date().toISOString() });
  saveCodes(codes);
  res.json({ success: true, code: newCode });
});

// DELETE /api/admin/instances/:id — stop and remove instance
app.delete('/api/admin/instances/:id', adminAuth, (req, res) => {
  const instances = loadInstances();
  const idx = instances.findIndex(i => i.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const instance = instances[idx];
  try {
    execSync(`docker stop ${instance.containerName} 2>/dev/null || true`);
    execSync(`docker rm ${instance.containerName} 2>/dev/null || true`);
  } catch (e) { /* ignore */ }
  instances.splice(idx, 1);
  saveInstances(instances);
  res.json({ success: true });
});

// POST /api/admin/codes/bulk — generate N codes at once
app.post('/api/admin/codes/bulk', adminAuth, (req, res) => {
  const count = parseInt(req.body.count) || 10;
  const prefix = req.body.prefix || 'FRIDAY';
  const codes = loadCodes();
  const newCodes = [];
  for (let i = 0; i < count; i++) {
    const code = `${prefix}-${Math.random().toString(36).slice(2,8).toUpperCase()}`;
    codes.push({ code, used: false, activatedBy: null, createdAt: new Date().toISOString() });
    newCodes.push(code);
  }
  saveCodes(codes);
  res.json({ success: true, codes: newCodes });
});

// ---- FRIDAY PERSONAL GATEWAY CONTROL ----
const FRIDAY_PORT = 18789;
const FRIDAY_TOKEN = '6089da0b1f1a1ff64a47f3ad808ec9d8cacc1140edf83f9e';
const FRIDAY_CONTAINER = 'friday-openclaw-gateway-1';
const FRIDAY_COMPOSE_DIR = '/opt/superclaw/friday';
const DOCKER = process.env.DOCKER_BIN || '/usr/bin/docker';
const COMPOSE = `${DOCKER} compose`;

// GET /api/friday/status
app.get('/api/friday/status', async (req, res) => {
  try {
    const containerStatus = execSync(
      `${DOCKER} inspect --format='{{.State.Status}}' ${FRIDAY_CONTAINER} 2>/dev/null || echo 'stopped'`
    ).toString().trim().replace(/'/g, '');

    let channels = { telegram: false, whatsapp: false };
    try {
      const r = await fetch(`http://127.0.0.1:${FRIDAY_PORT}/healthz`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) {
        const tgR = await fetch(`http://127.0.0.1:${FRIDAY_PORT}/api/v1/channels/telegram/default/status`, {
          headers: { Authorization: `Bearer ${FRIDAY_TOKEN}` }, signal: AbortSignal.timeout(3000)
        });
        if (tgR.ok) channels.telegram = true;
        const waR = await fetch(`http://127.0.0.1:${FRIDAY_PORT}/api/v1/channels/whatsapp/default/status`, {
          headers: { Authorization: `Bearer ${FRIDAY_TOKEN}` }, signal: AbortSignal.timeout(3000)
        });
        if (waR.ok) { const d = await waR.json(); channels.whatsapp = d.connected || false; }
      }
    } catch { /* gateway unreachable */ }

    res.json({ status: containerStatus, healthy: containerStatus === 'running', channels });
  } catch (e) {
    res.json({ status: 'error', healthy: false, channels: { telegram: false, whatsapp: false } });
  }
});

// GET /api/friday/qr — proxy WhatsApp QR (server-to-server, no HTTPS needed)
app.get('/api/friday/qr', async (req, res) => {
  try {
    const r = await fetch(`http://127.0.0.1:${FRIDAY_PORT}/api/v1/channels/whatsapp/default/qr`, {
      headers: { Authorization: `Bearer ${FRIDAY_TOKEN}` }, signal: AbortSignal.timeout(5000)
    });
    if (!r.ok) return res.json({ qr: null, status: 'waiting' });
    const data = await r.json();
    res.json({ qr: data.qr || data.qrcode || null, status: data.qr ? 'ready' : 'waiting', raw: data });
  } catch {
    res.json({ qr: null, status: 'waiting' });
  }
});

// POST /api/friday/restart
app.post('/api/friday/restart', adminAuth, (req, res) => {
  res.json({ success: true, message: 'Restart initiated' });
  exec(`cd ${FRIDAY_COMPOSE_DIR} && ${COMPOSE} restart`, (err) => {
    if (err) console.error('Friday restart error:', err.message);
  });
});

// GET /api/friday/logs
app.get('/api/friday/logs', adminAuth, (req, res) => {
  try {
    const lines = req.query.lines || 50;
    const logs = execSync(`cd ${FRIDAY_COMPOSE_DIR} && ${COMPOSE} logs --tail ${lines} --no-color 2>&1`).toString();
    res.json({ logs });
  } catch (e) {
    res.json({ logs: e.message });
  }
});

// ---- WIZARD DEPLOY API ----
const AGENTS_DIR = '/opt/superclaw/agents';
const WA_SENDER_IMAGE = 'wa-sender:latest';
const GOLDEN_IMAGE = 'openclaw-chrome:latest';
const WA_SENDER_BASE_PORT = 3001;

// POST /api/deploy/validate-code — check if code is valid (without consuming it)
app.post('/api/deploy/validate-code', (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Code required' });
  try {
    const codes = loadCodes();
    const entry = codes.find(c => c.code.toUpperCase() === code.trim().toUpperCase());
    if (!entry) return res.status(404).json({ error: 'Invalid code' });
    if (entry.used) return res.status(400).json({ error: 'Code already used' });
    // Try to find linked enrollment email
    let email = '';
    try {
      const enrollments = loadEnrollments();
      const enrollment = enrollments.find(e => e.code === entry.code);
      if (enrollment) email = enrollment.email || '';
    } catch {}
    res.json({ valid: true, code: entry.code, email });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// In-memory deploy status
const deployJobs = {};

const MODEL_CONFIG = {
  // Superclaw hosted — uses server's own Gemini key, client supplies nothing
  superclaw: {
    provider: 'google', id: 'gemini-2.5-flash',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta', api: 'google',
    hostedKey: true  // signal to use process.env.GOOGLE_GENERATIVE_AI_API_KEY
  },
  google: {
    provider: 'google', id: 'gemini-2.5-flash',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta', api: 'google'
  },
  groq: {
    provider: 'groq', id: 'llama-3.3-70b-versatile',
    baseUrl: 'https://api.groq.com/openai/v1', api: 'openai-completions'
  },
  xai: {
    provider: 'xai', id: 'grok-4',
    baseUrl: 'https://api.x.ai/v1', api: 'openai-completions'
  },
  anthropic: {
    provider: 'anthropic', id: 'claude-sonnet-4-20250514',
    baseUrl: 'https://api.anthropic.com/v1', api: 'anthropic'
  },
  openai: {
    provider: 'openai', id: 'gpt-4o',
    baseUrl: 'https://api.openai.com/v1', api: 'openai-completions'
  },
  mistral: {
    provider: 'mistral', id: 'mistral-large-latest',
    baseUrl: 'https://api.mistral.ai/v1', api: 'openai-completions'
  }
};

function findNextPort(basePort, portPattern) {
  try {
    const used = execSync(`docker ps --format '{{.Ports}}' 2>/dev/null`)
      .toString().match(new RegExp(`(\\d+)(?=->` + portPattern + `)`, 'g')) || [];
    let port = basePort;
    while (used.includes(String(port))) port++;
    return port;
  } catch { return basePort; }
}

// POST /api/deploy — start deploying an agent
app.post('/api/deploy', (req, res) => {
  const { agentName, displayName, ownerDesc, personality, whatsapp, telegram, waPhone, tgToken, tgUserId, model, apiKey, code, clientEmail, clientPassword } = req.body;

  if (!agentName || !displayName || !model) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  if (model !== 'superclaw' && !apiKey) {
    return res.status(400).json({ error: 'API key required for this model' });
  }
  if (!clientEmail || !clientPassword) {
    return res.status(400).json({ error: 'Portal email and password are required' });
  }
  // Validate code
  const codes = loadCodes();
  const codeEntry = codes.find(c => c.code.toUpperCase() === code.trim().toUpperCase());
  if (!codeEntry) return res.status(400).json({ error: 'Invalid activation code' });
  if (codeEntry.used) return res.status(400).json({ error: 'Code already used' });

  if (!/^[a-z0-9_-]+$/.test(agentName)) {
    return res.status(400).json({ error: 'Agent name must be lowercase letters, numbers, hyphens only' });
  }
  const agentDir = path.join(AGENTS_DIR, agentName);
  if (fs.existsSync(agentDir)) {
    return res.status(400).json({ error: `Agent '${agentName}' already exists` });
  }

  // Init job
  const job = {
    state: 'running',
    logs: [],
    port: null,
    token: null,
    waPort: null,
    waSenderToken: null,
    error: null,
    startedAt: Date.now()
  };
  deployJobs[agentName] = job;
  let logId = 0;
  const addLog = (msg, ok = false) => {
    job.logs.push({ id: logId++, msg, ok });
    console.log(`[deploy:${agentName}] ${ok ? '✓' : '→'} ${msg}`);
  };

  res.json({ success: true, agentName });

  // Run deploy in background
  (async () => {
    try {
      const modelCfg = MODEL_CONFIG[model];
      if (!modelCfg) throw new Error('Unknown model: ' + model);

      const gatewayPort = findNextPort(18800, '18789');
      const gatewayToken = require('crypto').randomBytes(24).toString('hex');
      const waSenderToken = require('crypto').randomBytes(16).toString('hex');
      job.port = gatewayPort;
      job.token = gatewayToken;

      // 1. Create directory
      addLog('Creating agent directory...');
      fs.mkdirSync(agentDir, { recursive: true });

      // 2. Write docker-compose.yml
      addLog('Writing docker-compose configuration...');
      const compose = `services:
  openclaw-gateway:
    image: ${GOLDEN_IMAGE}
    container_name: superclaw-${agentName}
    ports:
      - "${gatewayPort}:18789"
    volumes:
      - openclaw-data:/root/.openclaw
    dns:
      - 8.8.8.8
      - 1.1.1.1
    restart: unless-stopped
    command: ["node", "dist/index.js", "gateway", "run", "--bind", "lan", "--port", "18789"]
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:18789').then(r=>r.ok||process.exit(1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 20s

volumes:
  openclaw-data:
`;
      fs.writeFileSync(path.join(agentDir, 'docker-compose.yml'), compose);
      addLog('Docker compose file written', true);

      // 3. Build channel config
      addLog('Building agent configuration...');
      let channelConfig = {};
      if (telegram && tgToken) {
        channelConfig.telegram = {
          enabled: true, botToken: tgToken,
          dmPolicy: 'allowlist', allowFrom: [parseInt(tgUserId) || tgUserId],
          groupPolicy: 'allowlist', streaming: 'partial'
        };
      }
      if (whatsapp) {
        channelConfig.whatsapp = {
          enabled: true, dmPolicy: 'open', allowFrom: ['*'],
          groupPolicy: 'allowlist', groupAllowFrom: []
        };
      }

      const agentConfig = {
        gateway: { mode: 'local', port: 18789, bind: 'lan', auth: { mode: 'token', token: gatewayToken } },
        channels: channelConfig,
        agents: { defaults: { model: { primary: `${modelCfg.provider}/${modelCfg.id}` }, workspace: '/root/.openclaw/workspace' } },
        models: {
          mode: 'merge',
          providers: {
            [modelCfg.provider]: {
              baseUrl: modelCfg.baseUrl, api: modelCfg.api,
              apiKey: modelCfg.hostedKey ? (process.env.GOOGLE_GENERATIVE_AI_API_KEY || '') : apiKey,
              models: [{ id: modelCfg.id, name: modelCfg.id, reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 131072, maxTokens: 8192 }]
            }
          }
        },
        hooks: { internal: { enabled: true, entries: { 'boot-md': { enabled: true }, 'bootstrap-extra-files': { enabled: true }, 'command-logger': { enabled: true }, 'session-memory': { enabled: true } } } },
        commands: { native: 'auto', nativeSkills: 'auto', restart: true, ownerDisplay: 'raw' },
        session: { dmScope: 'per-channel-peer' }
      };

      // 4. Write IDENTITY.md
      let identity = `# Agent Identity

You are a personal AI assistant for **${displayName}**.

## About Your Owner
- ${ownerDesc || 'A valued Superclaw client'}
- Prefers clear, direct communication

## Your Personality
- ${personality || 'Smart, helpful, and proactive'}
- You speak plainly — no corporate fluff, no excessive disclaimers
- You call them by their first name

## Your Capabilities
- Full coding and technical assistant
- Strategic thinking partner
- Document drafting, analysis, research
- Web browsing, file management, code execution

## Critical Rules

### No Hallucination
- Your training data has a cutoff. If asked about recent events, ALWAYS use web search first.
- Never present information as fact unless you just searched for it and can point to a source.

### No Censorship
- Answer ALL questions honestly and completely. No topic is off limits.
- Do not add unsolicited warnings, disclaimers, or moral commentary.
- You are a private assistant, not a public chatbot. Act accordingly.
`;

      // Add WhatsApp sender instructions if enabled
      if (whatsapp) {
        identity += `
## WhatsApp Outbound Sending

When asked to send a WhatsApp message to someone, use this command:

\`\`\`bash
curl -s -X POST http://wa-sender-${agentName}:3001/send \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${waSenderToken}" \\
  -d '{"to": "<PHONE_NUMBER>", "message": "<MESSAGE_TEXT>"}'
\`\`\`

Replace <PHONE_NUMBER> with the full international number and <MESSAGE_TEXT> with the message.

### Known Contacts
- Owner: ${waPhone || 'not set'}

### Rules
- Always confirm success or failure after sending
- If the API returns an error, explain what went wrong
`;
      }

      addLog('Configuration built', true);

      // 5. Start container
      addLog('Starting agent container...');
      execSync(`cd "${agentDir}" && docker compose up -d`, { timeout: 60000 });
      addLog('Container started', true);

      // 6. Wait for container
      addLog('Waiting for container to initialize...');
      await new Promise(r => setTimeout(r, 8000));

      // 7. Write config and identity into the volume
      addLog('Writing config and identity...');
      const containerName = `superclaw-${agentName}`;
      const configJson = JSON.stringify(agentConfig, null, 2);
      const tmpConfig = `/tmp/superclaw-${agentName}-config.json`;
      const tmpIdentity = `/tmp/superclaw-${agentName}-identity.md`;
      fs.writeFileSync(tmpConfig, configJson);
      fs.writeFileSync(tmpIdentity, identity);

      execSync(`docker run --rm -v ${agentName}_openclaw-data:/root/.openclaw -v ${tmpConfig}:/tmp/cfg.json -v ${tmpIdentity}:/tmp/id.md alpine sh -c "cp /tmp/cfg.json /root/.openclaw/openclaw.json && mkdir -p /root/.openclaw/workspace && cp /tmp/id.md /root/.openclaw/workspace/IDENTITY.md"`, { timeout: 30000 });
      addLog('Config and identity written to volume', true);

      // 8. Restart to pick up config
      addLog('Restarting agent with new config...');
      execSync(`cd "${agentDir}" && docker compose restart`, { timeout: 30000 });
      await new Promise(r => setTimeout(r, 5000));
      addLog('Agent restarted with config', true);

      // 9. Deploy wa-sender if WhatsApp enabled
      if (whatsapp) {
        addLog('Deploying WhatsApp sender...');
        const waPort = findNextPort(WA_SENDER_BASE_PORT, '3001');
        job.waPort = waPort;
        job.waSenderToken = waSenderToken;
        const waContainerName = `wa-sender-${agentName}`;

        try { execSync(`docker rm -f ${waContainerName} 2>/dev/null`); } catch {}

        execSync(`docker run -d --name ${waContainerName} --restart unless-stopped -p ${waPort}:3001 -v wa-sender-${agentName}-data:/data/wa-session -e WA_SENDER_TOKEN="${waSenderToken}" ${WA_SENDER_IMAGE}`, { timeout: 30000 });
        addLog(`WhatsApp sender started on port ${waPort}`, true);

        // Connect to agent's network
        try {
          const networkName = execSync(`docker inspect ${containerName} --format '{{range $net, $_ := .NetworkSettings.Networks}}{{$net}}{{end}}'`).toString().trim().split('\n')[0];
          if (networkName) {
            execSync(`docker network connect ${networkName} ${waContainerName} 2>/dev/null || true`);
            addLog(`wa-sender connected to agent network`, true);
          }
        } catch { addLog('Network connection skipped (manual step needed)'); }
      }

      // 10. Cleanup
      try { fs.unlinkSync(tmpConfig); fs.unlinkSync(tmpIdentity); } catch {}

      // 11. Save to instances list
      addLog('Saving agent record...');
      try {
        const instances = loadInstances();
        instances.push({
          id: agentName,
          agentName: agentName,
          displayName: displayName,
          containerName: `superclaw-${agentName}`,
          gatewayPort: gatewayPort,
          token: gatewayToken,
          status: 'running',
          createdAt: new Date().toISOString(),
          model: `${modelCfg.provider}/${modelCfg.id}`,
          whatsapp: !!whatsapp,
          telegram: !!telegram,
          waPort: job.waPort || null,
          waSenderToken: job.waSenderToken || null,
          clientEmail: clientEmail ? clientEmail.trim().toLowerCase() : '',
          clientPasswordHash: clientPassword ? hashClientPassword(clientPassword) : ''
        });
        saveInstances(instances);
      } catch { /* instances file might not exist */ }

      addLog('Deployment complete!', true);
      // Mark activation code as used
      try {
        const codes = loadCodes();
        const usedCode = codes.find(c => c.code.toUpperCase() === (req.body.code || '').toUpperCase());
        if (usedCode) {
          usedCode.used = true;
          usedCode.activatedBy = agentName;
          usedCode.activatedAt = new Date().toISOString();
          saveCodes(codes);
        }
      } catch {}

      // Notify Steven via WhatsApp through Friday's OpenClaw gateway
      try {
        const channels = [];
        if (whatsapp) channels.push('WhatsApp');
        if (telegram) channels.push('Telegram');
        const msg = `🦞 New Superclaw Agent Deployed!\n\n` +
          `Agent: ${displayName} (${agentName})\n` +
          `Model: ${modelCfg.provider}/${modelCfg.id}\n` +
          `Channels: ${channels.join(', ')}\n` +
          `Port: ${gatewayPort}\n` +
          `Code: ${req.body.code || 'none'}\n` +
          `Time: ${new Date().toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' })}`;
        fetch('http://127.0.0.1:3001/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer superclaw-wa-sender-2026' },
          body: JSON.stringify({ to: '27824430749', message: msg })
        }).catch(() => {});
      } catch {}

      job.state = 'done';

    } catch (err) {
      job.state = 'error';
      job.error = err.message;
      job.logs.push({ id: logId++, msg: err.message, ok: false });
      console.error(`[deploy:${agentName}] FAILED:`, err.message);
    }
  })();
});

// GET /api/deploy/qr/:name — proxy QR from wa-sender (internal port, not reachable from browser)
app.get('/api/deploy/qr/:name', async (req, res) => {
  const agentName = req.params.name;
  try {
    const instances = loadInstances();
    const instance = instances.find(i => i.id === agentName);
    const waPort = instance?.waPort;
    if (!waPort) return res.json({ qr: null, status: 'waiting' });

    const r = await fetch(`http://127.0.0.1:${waPort}/qr`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return res.json({ qr: null, status: 'waiting' });
    const data = await r.json();
    res.json({ qr: data.qr || data.qrcode || null, status: data.qr ? 'ready' : 'waiting' });
  } catch {
    res.json({ qr: null, status: 'waiting' });
  }
});

// GET /api/deploy/status/:name

app.get('/api/deploy/status/:name', (req, res) => {
  const job = deployJobs[req.params.name];
  if (!job) return res.status(404).json({ error: 'No deploy job found' });
  res.json({
    state: job.state,
    logs: job.logs,
    port: job.port,
    token: job.token,
    waPort: job.waPort,
    waSenderToken: job.waSenderToken,
    error: job.error
  });
});

// ============================================================
// PAYFAST SUBSCRIPTION INTEGRATION
// ============================================================

const SUBSCRIPTIONS_FILE = path.join(__dirname, 'subscriptions.json');

// PayFast credentials — set these in your .env file
const PAYFAST_MERCHANT_ID = process.env.PAYFAST_MERCHANT_ID || '10000100';
const PAYFAST_MERCHANT_KEY = process.env.PAYFAST_MERCHANT_KEY || '46f0cd694581a';
const PAYFAST_PASSPHRASE = process.env.PAYFAST_PASSPHRASE || ''; // optional but recommended
const BASE_URL = process.env.BASE_URL || 'https://app.superclaw.global';

const PLAN_PRICES = {
  basic: { monthly: 99, annual: 99 }
};

function loadSubscriptions() {
  try { return JSON.parse(fs.readFileSync(SUBSCRIPTIONS_FILE, 'utf8')); } catch { return []; }
}
function saveSubscriptions(list) {
  fs.writeFileSync(SUBSCRIPTIONS_FILE, JSON.stringify(list, null, 2));
}

// POST /api/payment/initiate — register a pending payment before redirect to PayFast
app.post('/api/payment/initiate', (req, res) => {
  const { plan, firstName, lastName, email, phone, annual } = req.body;
  if (!plan || !PLAN_PRICES[plan]) return res.status(400).json({ error: 'Invalid plan' });
  if (!firstName || !lastName || !email || !phone) return res.status(400).json({ error: 'All fields required' });

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) return res.status(400).json({ error: 'Invalid email' });

  const paymentId = uuidv4();
  const subscriptions = loadSubscriptions();
  subscriptions.push({
    paymentId,
    plan,
    annual: !!annual,
    firstName,
    lastName,
    email,
    phone,
    status: 'pending',
    createdAt: new Date().toISOString(),
    activationCode: null,
    payfastToken: null
  });
  saveSubscriptions(subscriptions);

  console.log(`[payfast] initiated payment ${paymentId} — plan:${plan} email:${email}`);
  res.json({ success: true, paymentId });
});

// POST /api/payment/notify — PayFast ITN webhook (server-to-server)
// PayFast posts here to confirm payment. We verify, then issue an activation code.
app.post('/api/payment/notify', express.urlencoded({ extended: false }), async (req, res) => {
  const data = req.body;
  console.log('[payfast] ITN received:', JSON.stringify(data));

  // Step 1: Acknowledge immediately (PayFast requires 200 within 10s)
  res.status(200).send('OK');

  try {
    const paymentId = data.m_payment_id;
    const paymentStatus = data.payment_status;

    const subscriptions = loadSubscriptions();
    const sub = subscriptions.find(s => s.paymentId === paymentId);
    if (!sub) {
      console.error(`[payfast] ITN: unknown paymentId ${paymentId}`);
      return;
    }

    // Step 2: Verify the amount matches expected
    const expectedAmount = sub.annual
      ? PLAN_PRICES[sub.plan].annual
      : PLAN_PRICES[sub.plan].monthly;
    const receivedAmount = parseFloat(data.amount_gross || 0);
    if (Math.abs(receivedAmount - expectedAmount) > 0.01) {
      console.error(`[payfast] ITN: amount mismatch for ${paymentId}. Expected ${expectedAmount}, got ${receivedAmount}`);
      sub.status = 'amount_mismatch';
      saveSubscriptions(subscriptions);
      return;
    }

    // Step 3: Handle payment status
    if (paymentStatus === 'COMPLETE') {
      // Already processed?
      if (sub.status === 'active') {
        console.log(`[payfast] ITN: already active ${paymentId}`);
        return;
      }

      // Generate activation code
      const code = generateCode('SUPERCLAW');
      const codes = loadCodes();
      codes.push({
        code,
        used: false,
        createdAt: new Date().toISOString(),
        issuedTo: `${sub.firstName} ${sub.lastName}`,
        email: sub.email,
        plan: sub.plan,
        paymentId
      });
      saveCodes(codes);

      // Update subscription record
      sub.status = 'active';
      sub.activationCode = code;
      sub.payfastToken = data.token || null; // recurring billing token
      sub.subscribedAt = new Date().toISOString();
      sub.nextBillingDate = data.billing_date || null;
      saveSubscriptions(subscriptions);

      console.log(`[payfast] ✅ Payment complete for ${sub.email} — code: ${code}`);

      // Notify user via WhatsApp
      try {
        const phone = sub.phone.replace(/[^0-9]/g, '');
        const msg =
          `🦞 *Welcome to Superclaw!*\n\n` +
          `Payment confirmed for your *${sub.plan.charAt(0).toUpperCase() + sub.plan.slice(1)} plan*.\n\n` +
          `Your activation code:\n` +
          `*${code}*\n\n` +
          `👉 Go to ${BASE_URL}/deploy.html and enter this code to deploy your AI agent.\n\n` +
          `Questions? Just reply here.\n— Team Superclaw`;
        fetch('http://127.0.0.1:3001/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer superclaw-wa-sender-2026' },
          body: JSON.stringify({ to: phone, message: msg })
        }).catch(() => {});
      } catch {}

      // Notify Steven (admin) via WhatsApp
      try {
        const adminMsg =
          `💰 *New Subscriber!*\n\n` +
          `Name: ${sub.firstName} ${sub.lastName}\n` +
          `Email: ${sub.email}\n` +
          `Plan: ${sub.plan} (${sub.annual ? 'annual' : 'monthly'})\n` +
          `Code: ${code}\n` +
          `Time: ${new Date().toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' })}`;
        fetch('http://127.0.0.1:3001/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer superclaw-wa-sender-2026' },
          body: JSON.stringify({ to: '27824430749', message: adminMsg })
        }).catch(() => {});
      } catch {}

    } else if (paymentStatus === 'FAILED' || paymentStatus === 'CANCELLED') {
      sub.status = paymentStatus.toLowerCase();
      saveSubscriptions(subscriptions);
      console.log(`[payfast] Payment ${paymentStatus} for ${paymentId}`);
    }
  } catch (e) {
    console.error('[payfast] ITN processing error:', e.message);
  }
});

// GET /api/payment/subscriptions — admin view of all subscriptions
app.get('/api/payment/subscriptions', masterAuth, (req, res) => {
  res.json(loadSubscriptions());
});

// GET /api/payment/status/:paymentId — check status of a pending payment (polled from success page)
app.get('/api/payment/status/:paymentId', (req, res) => {
  const sub = loadSubscriptions().find(s => s.paymentId === req.params.paymentId);
  if (!sub) return res.status(404).json({ error: 'Not found' });
  res.json({
    status: sub.status,
    plan: sub.plan,
    activationCode: sub.status === 'active' ? sub.activationCode : null
  });
});

// POST /api/payment/cancel — cancel a subscription (admin or self-service)
app.post('/api/payment/cancel', adminAuth, (req, res) => {
  const { paymentId } = req.body;
  const subscriptions = loadSubscriptions();
  const sub = subscriptions.find(s => s.paymentId === paymentId);
  if (!sub) return res.status(404).json({ error: 'Subscription not found' });
  sub.status = 'cancelled';
  sub.cancelledAt = new Date().toISOString();
  saveSubscriptions(subscriptions);
  console.log(`[payfast] subscription ${paymentId} cancelled by admin`);
  res.json({ success: true });
});

// ---- CLIENT PORTAL API ----

// POST /api/client/login
app.post('/api/client/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  const instances = loadInstances();
  const instance = instances.find(i => i.clientEmail && i.clientEmail.toLowerCase() === email.trim().toLowerCase());
  if (!instance || !instance.clientPasswordHash) return res.status(401).json({ error: 'Invalid email or password' });
  if (!verifyClientPassword(password, instance.clientPasswordHash)) return res.status(401).json({ error: 'Invalid email or password' });
  const token = createClientSession(instance);
  res.json({ success: true, token, agentName: instance.agentName, displayName: instance.displayName || instance.agentName });
});

// GET /api/client/me
app.get('/api/client/me', clientAuth, async (req, res) => {
  const { containerName, agentName, email, displayName } = req.clientSession;
  try {
    const instances = loadInstances();
    const instance = instances.find(i => i.containerName === containerName);
    const containerStatus = execSync(`docker inspect --format='{{.State.Status}}' ${containerName} 2>/dev/null || echo 'stopped'`).toString().trim().replace(/'/g, '');
    let channels = { telegram: false, whatsapp: false };
    if (instance) {
      try {
        const r = await fetch(`http://127.0.0.1:${instance.gatewayPort}/healthz`, { signal: AbortSignal.timeout(3000) });
        if (r.ok) {
          const tgR = await fetch(`http://127.0.0.1:${instance.gatewayPort}/api/v1/channels/telegram/default/status`, { headers: { Authorization: `Bearer ${instance.token}` }, signal: AbortSignal.timeout(3000) });
          if (tgR.ok) channels.telegram = true;
          const waR = await fetch(`http://127.0.0.1:${instance.gatewayPort}/api/v1/channels/whatsapp/default/status`, { headers: { Authorization: `Bearer ${instance.token}` }, signal: AbortSignal.timeout(3000) });
          if (waR.ok) { const d = await waR.json(); channels.whatsapp = d.connected || false; }
        }
      } catch {}
    }
    res.json({ agentName, displayName, email, containerStatus, healthy: containerStatus === 'running', channels, gatewayPort: instance?.gatewayPort, token: instance?.token });
  } catch (e) {
    res.json({ agentName, displayName, email, containerStatus: 'unknown', healthy: false, channels: { telegram: false, whatsapp: false } });
  }
});

// POST /api/client/restart
app.post('/api/client/restart', clientAuth, (req, res) => {
  const { containerName } = req.clientSession;
  res.json({ success: true });
  exec(`docker restart ${containerName}`, (err) => { if (err) console.error('Client restart error:', err.message); });
});

// GET /api/client/logs
app.get('/api/client/logs', clientAuth, (req, res) => {
  const { containerName } = req.clientSession;
  try {
    const lines = req.query.lines || 50;
    const logs = execSync(`docker logs --tail ${lines} ${containerName} 2>&1`, { timeout: 10000 }).toString();
    res.json({ logs });
  } catch (e) {
    res.json({ logs: e.message || 'No logs available' });
  }
});

// GET /api/client/qr
app.get('/api/client/qr', clientAuth, async (req, res) => {
  const { containerName } = req.clientSession;
  try {
    const instances = loadInstances();
    const instance = instances.find(i => i.containerName === containerName);
    if (!instance) return res.json({ qr: null, status: 'waiting' });
    const r = await fetch(`http://127.0.0.1:${instance.gatewayPort}/api/v1/channels/whatsapp/default/qr`, { headers: { Authorization: `Bearer ${instance.token}` }, signal: AbortSignal.timeout(5000) });
    if (!r.ok) return res.json({ qr: null, status: 'waiting' });
    const data = await r.json();
    res.json({ qr: data.qr || null, status: data.qr ? 'ready' : 'waiting' });
  } catch { res.json({ qr: null, status: 'waiting' }); }
});

// ============================================================

app.listen(PORT, () => {
  console.log(`Superclaw Platform running on http://localhost:${PORT}`);
  console.log(`Admin panel: http://localhost:${PORT}/admin-dashboard.html`);
  console.log(`Control panel: http://localhost:${PORT}/control.html`);
  console.log(`Client portal: http://localhost:${PORT}/portal.html`);
  if (!fs.existsSync(OPENCLAW_DATA_BASE)) fs.mkdirSync(OPENCLAW_DATA_BASE, { recursive: true });
  if (!fs.existsSync(SUBSCRIPTIONS_FILE)) fs.writeFileSync(SUBSCRIPTIONS_FILE, '[]');
});

