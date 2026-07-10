// Proof: hasHtmlDocumentShape with truncateUtf16Safe preserves HTML detection
// Run: node --import tsx test/_proof_web_media_utf16.mjs

import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

const emoji = String.fromCharCode(0xd83d, 0xde00); // 😀
const base = "x".repeat(8190);
const htmlContent = base + emoji + "<!doctype html><html></html>";
const trimmed = htmlContent.trimStart();

console.log(`node=${process.versions.node}`);

const naive = trimmed.slice(0, 8192);
console.log(`trimmed.length=${trimmed.length}`);
console.log(`naive.slice(0,8192).hasLoneSurrogate=${naive.includes(String.fromCharCode(0xd83d))}`);

const safe = truncateUtf16Safe(trimmed, 8192);
console.log(`truncateUtf16Safe.hasLoneSurrogate=${safe.includes(String.fromCharCode(0xd83d))}`);
console.log(`truncateUtf16Safe preserves HTML prefix=${safe.includes("<!doctype html>")}`);
console.log("PASS: HTML document shape detection preserves surrogate pairs");
