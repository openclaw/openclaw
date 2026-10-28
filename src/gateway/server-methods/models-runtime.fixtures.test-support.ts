import { configForProviders } from "../../agents/model-auth.fixtures.test-support.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayAgentRuntime } from "../../shared/session-types.js";

export const EXPECTED_DEMO_IDENTITY = {
  id: "demo-model",
  name: "Demo Model",
  provider: "demo-provider",
};

export function thinkingLevels(levels: string) {
  return levels.split(" ").map((id) => ({ id, label: id }));
}

export function claudeOptOutConfig(modelId: string): OpenClawConfig {
  return {
    agents: {
      defaults: { models: { [`anthropic/${modelId}`]: { agentRuntime: { id: "claude-cli" } } } },
    },
    models: configForProviders({
      anthropic: { models: [{ id: modelId, name: modelId, reasoning: false }] },
    }).models,
  } as unknown as OpenClawConfig;
}

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
