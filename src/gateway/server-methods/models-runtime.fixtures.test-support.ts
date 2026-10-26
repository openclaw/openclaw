import type { GatewayAgentRuntime } from "../../shared/session-types.js";

const OPENCLAW_DEVICE_PLACEMENT: NonNullable<GatewayAgentRuntime["devicePlacement"]> = {
  requiredNodeCommands: [],
  consumesWorkerSlot: true,
};

export const EXPECTED_IMPLICIT_CODEX_RUNTIME: GatewayAgentRuntime = {
  id: "codex",
  cloudPlacementSupported: false,
  devicePlacementSupported: false,
  source: "implicit",
};

export const EXPECTED_IMPLICIT_OPENCLAW_RUNTIME: GatewayAgentRuntime = {
  id: "openclaw",
  cloudPlacementSupported: true,
  cloudPlacementExecutionMode: "worker-turn",
  devicePlacement: OPENCLAW_DEVICE_PLACEMENT,
  devicePlacementSupported: true,
  source: "implicit",
};
