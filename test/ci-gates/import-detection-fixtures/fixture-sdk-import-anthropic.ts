/**
 * FIXTURE: Gate A - Static import of Anthropic SDK (single quotes)
 * This file MUST trigger CI gate failure when scanned.
 * DO NOT fix this file - it exists to prove detection works.
 */

import Anthropic from "@anthropic-ai/sdk";

export function deliberatelyBadCode() {
  const client = new Anthropic();
  return client;
}
