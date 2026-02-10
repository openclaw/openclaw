#!/usr/bin/env node

// Test script to verify redaction logic
import { redactConfigObject, REDACTED_SENTINEL } from "./dist/config/redact-snapshot.js";

const testConfig = {
  models: {
    default: {
      maxTokens: 4096, // Should NOT be redacted
      maxOutputTokens: 2048, // Should NOT be redacted
      minTokens: 100, // Should NOT be redacted
    },
  },
  channels: {
    discord: {
      token: "secret-discord-token", // SHOULD be redacted
      botToken: "secret-bot-token", // SHOULD be redacted
    },
    telegram: {
      botToken: "telegram-secret", // SHOULD be redacted
      maxTokens: 8192, // Should NOT be redacted
    },
    openai: {
      apiKey: "sk-xxxxx", // SHOULD be redacted
      authToken: "auth-secret", // SHOULD be redacted
      tokenLimit: 128000, // Should NOT be redacted
    },
  },
  auth: {
    password: "mypassword", // SHOULD be redacted
    secret: "mysecret", // SHOULD be redacted
  },
  config: {
    totalTokens: 999999, // Should NOT be redacted
    tokenCount: 500, // Should NOT be redacted
  },
};

console.log("Testing redaction logic...\n");
console.log("Original config:");
console.log(JSON.stringify(testConfig, null, 2));

const redacted = redactConfigObject(testConfig);

console.log("\n\nRedacted config:");
console.log(JSON.stringify(redacted, null, 2));

// Verify expectations
console.log("\n\nVerification:");
const checks = [
  { path: "models.default.maxTokens", expected: 4096, actual: redacted.models.default.maxTokens },
  {
    path: "models.default.maxOutputTokens",
    expected: 2048,
    actual: redacted.models.default.maxOutputTokens,
  },
  { path: "models.default.minTokens", expected: 100, actual: redacted.models.default.minTokens },
  {
    path: "channels.discord.token",
    expected: REDACTED_SENTINEL,
    actual: redacted.channels.discord.token,
  },
  {
    path: "channels.discord.botToken",
    expected: REDACTED_SENTINEL,
    actual: redacted.channels.discord.botToken,
  },
  {
    path: "channels.telegram.botToken",
    expected: REDACTED_SENTINEL,
    actual: redacted.channels.telegram.botToken,
  },
  {
    path: "channels.telegram.maxTokens",
    expected: 8192,
    actual: redacted.channels.telegram.maxTokens,
  },
  {
    path: "channels.openai.apiKey",
    expected: REDACTED_SENTINEL,
    actual: redacted.channels.openai.apiKey,
  },
  {
    path: "channels.openai.authToken",
    expected: REDACTED_SENTINEL,
    actual: redacted.channels.openai.authToken,
  },
  {
    path: "channels.openai.tokenLimit",
    expected: 128000,
    actual: redacted.channels.openai.tokenLimit,
  },
  { path: "auth.password", expected: REDACTED_SENTINEL, actual: redacted.auth.password },
  { path: "auth.secret", expected: REDACTED_SENTINEL, actual: redacted.auth.secret },
  { path: "config.totalTokens", expected: 999999, actual: redacted.config.totalTokens },
  { path: "config.tokenCount", expected: 500, actual: redacted.config.tokenCount },
];

let allPassed = true;
checks.forEach((check) => {
  const passed = check.expected === check.actual;
  console.log(
    `${passed ? "✅" : "❌"} ${check.path}: ${passed ? "PASS" : `FAIL (expected ${JSON.stringify(check.expected)}, got ${JSON.stringify(check.actual)})`}`,
  );
  if (!passed) {
    allPassed = false;
  }
});

console.log(allPassed ? "\n✅ All tests passed!" : "\n❌ Some tests failed!");
process.exit(allPassed ? 0 : 1);
