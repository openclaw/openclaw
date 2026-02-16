import type { EmbeddedRunPayload } from "./types.js";

export function applyReasoningScaffoldsPhase0(
  payloads: EmbeddedRunPayload[],
): EmbeddedRunPayload[] {
  // Phase 0: wiring + config only. Intentionally a no-op.
  return payloads;
}
