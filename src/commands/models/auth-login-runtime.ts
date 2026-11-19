import { resolveModelRuntimePolicy } from "../../agents/model-runtime-policy.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { prepareSetupModelRuntime } from "../../system-agent/setup-model-selection.js";

/** Routes a login's starter model through the runtime its provider chose, unless one is already set. */
export function applyLoginAgentRuntime(
  cfg: OpenClawConfig,
  login: { agentId: string; result: { agentRuntimeId?: string } },
  model: string | undefined,
): OpenClawConfig {
  const { agentId } = login;
  const agentRuntimeId = login.result.agentRuntimeId;
  if (!model || !agentRuntimeId) {
    return cfg;
  }
  if (resolveModelRuntimePolicy({ config: cfg, modelId: model, agentId }).policy) {
    return cfg;
  }
  return prepareSetupModelRuntime({ config: cfg, modelRef: model, agentId, agentRuntimeId }).config;
}
