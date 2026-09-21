import type { GatewayAgentRuntime } from "../shared/session-types.js";

/** Codex identity can be resolved before its harness is registered in an isolated Gateway. */
export const UNREGISTERED_CODEX_RUNTIME = {
  id: "codex",
  cloudPlacementSupported: false,
  devicePlacementSupported: false,
  source: "implicit",
} as const satisfies GatewayAgentRuntime;
