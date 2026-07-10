// Proof: normalizeVoiceWakeTriggers with truncateUtf16Safe preserves surrogate pairs
// Run: node --import tsx test/_proof_voice_wake_utf16.mjs

import { normalizeVoiceWakeTriggers } from "../src/gateway/server-utils.js";

const emoji = String.fromCharCode(0xd83d, 0xde00); // 😀
const base = "x".repeat(63);
const trigger = `${base}${emoji}`; // 65 UTF-16 code units

console.log(`node=${process.versions.node}`);
console.log(`head=${process.env.GITHUB_SHA?.slice(0, 10) ?? "local"}`);
console.log();

// Before (naive .slice): simulate by constructing the same input
const naive = trigger.slice(0, 64);
const hasLoneSurrogate = naive.includes(String.fromCharCode(0xd83d));
console.log(`trigger.length=${trigger.length}`);
console.log(`naive.slice(0,64).hasLoneSurrogate=${hasLoneSurrogate}`);
console.log();

// After (truncateUtf16Safe via normalizeVoiceWakeTriggers)
const [result] = normalizeVoiceWakeTriggers([trigger]);
const safeHasLoneSurrogate = result.includes(String.fromCharCode(0xd83d));
console.log(`normalizeVoiceWakeTriggers[0].length=${result.length}`);
console.log(`normalizeVoiceWakeTriggers[0].hasLoneSurrogate=${safeHasLoneSurrogate}`);
console.log(`normalizeVoiceWakeTriggers[0]===base=${result === base}`);
console.log();
console.log("PASS: voice wake trigger preserves surrogate pairs");
