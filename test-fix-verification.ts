#!/usr/bin/env node

import { extractContentFromMessage } from "./src/tui/tui-formatters.js";

// Test various message formats to ensure newlines are preserved

console.log("=== Testing TUI Newline Fix ===\n");

// Test 1: String content with newlines
const msg1 = {
  content: "Line 1\nLine 2\nLine 3\n\nParagraph 2\nLine A\nLine B",
};

const result1 = extractContentFromMessage(msg1);
console.log("Test 1 - String content:");
console.log("Input:", JSON.stringify(msg1.content));
console.log("Output:", JSON.stringify(result1));
console.log("Expected:", JSON.stringify(msg1.content));
console.log("Pass:", result1 === msg1.content);
console.log();

// Test 2: Array content with text blocks
const msg2 = {
  content: [
    { type: "text", text: "First block\nWith newlines" },
    { type: "text", text: "Second block\nAlso with\nnewlines" },
  ],
};

const result2 = extractContentFromMessage(msg2);
const expected2 = "First block\nWith newlines\nSecond block\nAlso with\nnewlines";
console.log("Test 2 - Array content:");
console.log("Output:", JSON.stringify(result2));
console.log("Expected:", JSON.stringify(expected2));
console.log("Pass:", result2 === expected2);
console.log();

// Test 3: Exec tool output simulation
const msg3 = {
  content: [{ type: "text", text: "$ echo -e 'Line 1\\nLine 2\\nLine 3'\nLine 1\nLine 2\nLine 3" }],
};

const result3 = extractContentFromMessage(msg3);
console.log("Test 3 - Exec tool output:");
console.log("Output:");
console.log(result3);
console.log("\nNewlines preserved:", result3.includes("\n"));
console.log();
