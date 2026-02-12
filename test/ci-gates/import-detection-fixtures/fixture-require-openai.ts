/**
 * FIXTURE: Gate A - CommonJS require of OpenAI SDK
 * This file MUST trigger CI gate failure when scanned.
 * DO NOT fix this file - it exists to prove detection works.
 */

const OpenAI = require("openai");

export function deliberatelyBadCode() {
  const client = new OpenAI();
  return client;
}
