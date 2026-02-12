/**
 * FIXTURE: Gate A - Dynamic import of OpenAI SDK
 * This file MUST trigger CI gate failure when scanned.
 * DO NOT fix this file - it exists to prove detection works.
 */

export async function deliberatelyBadCode() {
  const OpenAI = await import("openai");
  const client = new OpenAI.default();
  return client;
}
