#!/usr/bin/env node

import { chunkByParagraph } from "./src/auto-reply/chunk.js";

// Test case from issue #13035
const testInput = `Line 1
Line 2
Line 3

Paragraph 2 Line 1
Paragraph 2 Line 2`;

console.log("Original text:");
console.log(testInput);
console.log("\n---\n");

console.log("After chunkByParagraph (limit: 1000):");
const chunks = chunkByParagraph(testInput, 1000);
chunks.forEach((chunk, i) => {
  console.log(`Chunk ${i + 1}:`);
  console.log(chunk);
  console.log("---");
});

console.log("\nCheck: Does chunkByParagraph preserve single newlines within paragraphs?");
const singleParagraph = "Line 1\nLine 2\nLine 3";
const chunkedSingle = chunkByParagraph(singleParagraph, 1000);
console.log("Input:", JSON.stringify(singleParagraph));
console.log("Output:", JSON.stringify(chunkedSingle[0]));
console.log("Preserved?", chunkedSingle[0] === singleParagraph);
