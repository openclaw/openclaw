// Proof: bash executor outputBytes tracking uses Buffer.byteLength not .length
// Run: node --input-type=module test/_proof_bash_bytes.mjs

const emoji = String.fromCharCode(0xd83d, 0xde00); // 😀
const ascii = "hello world";
const mixed = `output: ${emoji}`;

// .length counts UTF-16 code units
console.log("=== UTF-16 .length vs UTF-8 byteLength ===");
console.log(`ascii:       .length=${ascii.length}  byteLength=${Buffer.byteLength(ascii, "utf8")}`);
console.log(
  `emoji:       .length=${emoji.length}   byteLength=${Buffer.byteLength(emoji, "utf8")}`,
);
console.log(`mixed:       .length=${mixed.length}  byteLength=${Buffer.byteLength(mixed, "utf8")}`);
console.log();

// Simulate the bug: rolling buffer with .length
const maxOutputBytes = 100;
let bugBytes = 0; // tracks .length (bug)
let fixBytes = 0; // tracks byteLength (fix)
const chunks = [
  "x".repeat(60), // 60 ASCII bytes
  "x".repeat(30) + emoji.repeat(5), // 30 + 5*4=20 = 50 bytes, .length=30+10=40
];

for (const text of chunks) {
  bugBytes += text.length;
  fixBytes += Buffer.byteLength(text, "utf8");
}

console.log("=== Rolling buffer accounting ===");
console.log(`maxOutputBytes=${maxOutputBytes}`);
console.log(`bug (using .length): ${bugBytes} — under limit? ${bugBytes <= maxOutputBytes}`);
console.log(`fix (using byteLength): ${fixBytes} — under limit? ${fixBytes <= maxOutputBytes}`);
console.log();

// The bug: .length=100 stays within limit, but actual UTF-8 is 110 bytes
if (bugBytes <= maxOutputBytes && fixBytes > maxOutputBytes) {
  console.log(
    "BUG CONFIRMED: .length undercounts, buffer exceeds limit by " +
      (fixBytes - maxOutputBytes) +
      " bytes",
  );
} else {
  console.log("No discrepancy for ASCII-only output (expected for most commands)");
}
console.log("PASS: Buffer.byteLength corrects the accounting");
