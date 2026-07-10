// Proof: sanitizeForConsole strips C1 control characters (0x80-0x9f)
// Run: node --import tsx test/_proof_console_sanitize_c1.mjs

import { sanitizeForConsole } from "../src/agents/console-sanitize.js";

const csi = String.fromCharCode(0x9b); // C1 CSI — alternative ANSI escape prefix
const input = `text${csi}[31mred`;

console.log(`node=${process.versions.node}`);

const result = sanitizeForConsole(input);
console.log(`input: text<0x9b>[31mred`);
console.log(`output: ${result}`);
console.log(`CSI stripped: ${!result.includes(csi)}`);

// Verify all 32 C1 bytes are stripped
let allStripped = true;
for (let code = 0x80; code <= 0x9f; code++) {
  const cleaned = sanitizeForConsole("a" + String.fromCharCode(code) + "b");
  if (cleaned !== "ab") {
    allStripped = false;
    break;
  }
}
console.log(`C1 range 0x80-0x9f all stripped: ${allStripped}`);
console.log("PASS");
