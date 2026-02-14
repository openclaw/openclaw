#!/usr/bin/env node

import { extractContentFromMessage } from "./src/tui/tui-formatters.js";

// Simulate a message with newlines
const testMessage = {
  content: [
    {
      type: "text",
      text: "Line 1\nLine 2\nLine 3",
    },
  ],
};

const testMessageString = {
  content: "Line 1\nLine 2\nLine 3",
};

console.log("Test 1: Message with content array:");
const extracted1 = extractContentFromMessage(testMessage);
console.log("Input:", JSON.stringify(testMessage.content[0].text));
console.log("Output:", JSON.stringify(extracted1));
console.log("Newlines preserved?", extracted1 === "Line 1\nLine 2\nLine 3");

console.log("\nTest 2: Message with content string:");
const extracted2 = extractContentFromMessage(testMessageString);
console.log("Input:", JSON.stringify(testMessageString.content));
console.log("Output:", JSON.stringify(extracted2));
console.log("Newlines preserved?", extracted2 === "Line 1\nLine 2\nLine 3");
