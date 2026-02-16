import type { EmbeddedRunPayload, OpenClawConfigWithScaffolds } from "./types.js";
import { applyReasoningScaffoldsPhase0 } from "./phase0.js";

export function applyEmbeddedRunScaffolds(params: {
  payloads: EmbeddedRunPayload[];
  config?: OpenClawConfigWithScaffolds;
}): EmbeddedRunPayload[] {
  const cfg = params.config;
  const phase0Enabled = cfg?.scaffolds?.reasoning?.enabled ?? false;

  if (!phase0Enabled) {
    return params.payloads;
  }

  return applyReasoningScaffoldsPhase0(params.payloads);
}
