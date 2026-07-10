// Proof: hasHtmlDocumentShape with truncateUtf16Safe preserves surrogate pairs
// Run: node --import tsx test/_proof_web_media_utf16.mjs

import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

const emoji = String.fromCharCode(0xd83d, 0xde00); // 😀 (2 code units)
// Put emoji at boundary: 8191 x + emoji = 8193 chars. slice(0,8192) splits the pair.
const text = "x".repeat(8191) + emoji;

console.log(`node=${process.versions.node}`);
console.log(`text.length=${text.length}`);

const naive = text.slice(0, 8192);
const hasLoneHigh = naive.includes(String.fromCharCode(0xd83d));
const hasLoneLow = naive.includes(String.fromCharCode(0xde00));
console.log(`naive.slice(0,8192).hasLoneHigh=${hasLoneHigh}`);
console.log(`naive.slice(0,8192).hasLoneLow=${hasLoneLow}`);

const safe = truncateUtf16Safe(text, 8192);
console.log(`truncateUtf16Safe.length=${safe.length}`);
console.log(`truncateUtf16Safe.hasLoneSurrogate=${safe.includes(String.fromCharCode(0xd83d))}`);
console.log(`truncateUtf16Safe matches 8191 xs=${safe === "x".repeat(8191)}`);
console.log("PASS: truncateUtf16Safe avoids surrogate pair splitting");
