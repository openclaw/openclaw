// Applies Tool Search overlays on top of the selected runtime config.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { applyLocalModelLeanToolSearchDefaults } from "./local-model-lean.js";
import { resolveAgentRuntimeToolConfig } from "./tool-runtime-config.js";

export function resolveAgentToolSearchRuntimeConfig(params: {
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  forceDirectMessageTool?: boolean;
}): OpenClawConfig | undefined {
  const runtimeConfig = resolveAgentRuntimeToolConfig(params.config);
  if (params.forceDirectMessageTool) {
    return runtimeConfig;
  }
  return applyLocalModelLeanToolSearchDefaults({
    config: runtimeConfig,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
}
