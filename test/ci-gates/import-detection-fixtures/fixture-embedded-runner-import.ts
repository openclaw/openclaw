/**
 * FIXTURE: Gate B - Direct import of embedded runner module
 * This file MUST trigger CI gate failure when scanned.
 * DO NOT fix this file - it exists to prove detection works.
 */

import { runEmbeddedPiAgent } from "../../src/agents/pi-embedded-runner/run";

export async function deliberatelyBadCode() {
  const result = await runEmbeddedPiAgent({
    model: "claude-3-5-sonnet",
    messages: [],
  });
  return result;
}
