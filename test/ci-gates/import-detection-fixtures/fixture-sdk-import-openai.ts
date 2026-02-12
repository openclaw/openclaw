/**
 * FIXTURE: Gate A - Static import of OpenAI SDK (double quotes)
 * This file MUST trigger CI gate failure when scanned.
 * DO NOT fix this file - it exists to prove detection works.
 */

import OpenAI from "openai";

export function deliberatelyBadCode() {
  const client = new OpenAI();
  return client;
}
