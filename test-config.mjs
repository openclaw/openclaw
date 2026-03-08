import util from 'util';
import fs from 'fs';
// Mock Zod and schema stuff just directly parsing JSON
const raw = fs.readFileSync('/Users/syj/.openclaw/openclaw.json', 'utf8');
const cfg = JSON.parse(raw);

console.log("Raw from JSON:");
console.log(util.inspect(cfg.channels?.feishu?.groups, { depth: null, colors: true }));
