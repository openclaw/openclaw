/**
 * FIXTURE: Gate B - Aliased import of embedded runner
 * This file MUST trigger CI gate failure when scanned.
 * DO NOT fix this file - it exists to prove detection works.
 */

import { runEmbeddedPiAgent as executeAgent } from "../../src/agents/pi-embedded-runner/run";

export async function deliberatelyBadCode() {
  const result = await executeAgent({
    model: "claude-3-5-sonnet",
    messages: [],
  });
  return result;
}
