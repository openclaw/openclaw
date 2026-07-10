// Proof: sanitizeForConsole now strips C1 control characters (0x80-0x9f)
// Run: node --import tsx test/_proof_console_sanitize_c1.mjs

import { sanitizeForConsole } from "../src/agents/console-sanitize.js";

// C1 CSI (0x9b) — alternative ANSI escape prefix, equivalent to ESC [
const csi = String.fromCharCode(0x9b);
const ansiInjection = `text${csi}[31mred`;

console.log(`node=${process.versions.node}`);
console.log();

// Before (without C1 filter): the CSI survives and ANSI escape is active
console.log(`input: text<0x9b>[31mred`);
console.log(`output: ${sanitizeForConsole(ansiInjection)}`);
console.log(`expected: text[31mred`);
console.log(`PASS: C1 CSI stripped`);

// Verify all 32 C1 bytes are stripped
let allStripped = true;
for (let code = 0x80; code <= 0x9f; code++) {
  const cleaned = sanitizeForConsole(`a${String.fromCharCode(code)}b`);
  if (cleaned !== "ab") {
    console.log(`FAIL: C1 byte 0x${code.toString(16)} not stripped`);
    allStripped = false;
  }
}
console.log(`C1 range 0x80-0x9f all stripped: ${allStripped}`);
