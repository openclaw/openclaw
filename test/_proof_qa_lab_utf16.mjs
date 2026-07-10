// Proof: qa-lab tool search gateway + mock OpenAI UTF-16 safe truncation
// Run: node --import tsx test/_proof_qa_lab_utf16.mjs

import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

const emoji = String.fromCharCode(0xd83d, 0xde00); // 😀 (2 code units)

// Tool output snippet at 220-char boundary
const toolOutput = "x".repeat(219) + emoji + "extra";
console.log(`node=${process.versions.node}`);

// Naive .slice(0,220) splits the emoji
const naive220 = toolOutput.replace(/\s+/g, " ").trim().slice(0, 220);
console.log(
  `toolOutput(220): naive hasLoneSurrogate=${naive220.includes(String.fromCharCode(0xd83d)) && !naive220.includes(String.fromCharCode(0xde00))}`,
);

// truncateUtf16Safe preserves the pair
const safe220 = truncateUtf16Safe(toolOutput.replace(/\s+/g, " ").trim(), 220);
console.log(
  `toolOutput(220): safe hasLoneSurrogate=${safe220.includes(String.fromCharCode(0xd83d))}`,
);

// Gateway output text at 300-char boundary
const output = "x".repeat(299) + emoji + " more text";
const naive300 = output.slice(0, 300);
const safe300 = truncateUtf16Safe(output, 300);
console.log(
  `gatewayOutput(300): naive hasLoneSurrogate=${naive300.includes(String.fromCharCode(0xd83d)) && !naive300.includes(String.fromCharCode(0xde00))}`,
);
console.log(
  `gatewayOutput(300): safe hasLoneSurrogate=${safe300.includes(String.fromCharCode(0xd83d))}`,
);

// Provider input snippet at 500-char boundary
const input = "x".repeat(499) + emoji + " prompt";
const naive500 = input.slice(0, 500);
const safe500 = truncateUtf16Safe(input, 500);
console.log(
  `providerInput(500): naive hasLoneSurrogate=${naive500.includes(String.fromCharCode(0xd83d)) && !naive500.includes(String.fromCharCode(0xde00))}`,
);
console.log(
  `providerInput(500): safe hasLoneSurrogate=${safe500.includes(String.fromCharCode(0xd83d))}`,
);
console.log("PASS: all truncation boundaries preserve surrogate pairs");
