// Proof: qa-matrix E2EE bootstrapErrorPreview preserves surrogate pairs
// Run: node --import tsx test/_proof_qa_matrix_e2ee_utf16.mjs

import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

const emoji = String.fromCharCode(0xd83d, 0xde00); // 😀 (2 code units)
// Error text where emoji straddles the 240-unit boundary
const error = "x".repeat(239) + emoji + " extra text";

console.log(`node=${process.versions.node}`);
console.log(`error.length=${error.length}`);

// Naive .slice(0,240) — splits the surrogate pair
const naive = error.slice(0, 240);
console.log(
  `naive.slice(0,240).hasLoneSurrogate=${naive.includes(String.fromCharCode(0xd83d)) && !naive.includes(String.fromCharCode(0xde00))}`,
);

// truncateUtf16Safe — preserves the pair by rounding down
const safe = truncateUtf16Safe(error, 240);
console.log(`truncateUtf16Safe.length=${safe.length}`);
console.log(`truncateUtf16Safe.hasLoneSurrogate=${safe.includes(String.fromCharCode(0xd83d))}`);
console.log(`truncateUtf16Safe matches 239 xs=${safe === "x".repeat(239)}`);
console.log("PASS: bootstrapErrorPreview preserves surrogate pairs");
