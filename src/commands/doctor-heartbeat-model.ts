import { resolveAgentEffectiveModelPrimary } from "../agents/agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import { resolveAllowedModelRefCore } from "../agents/model-selection-resolve.js";
import { resolveConfiguredModelRef } from "../agents/model-selection-shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveHeartbeatConfig } from "./doctor-heartbeat-legacy.js";

/** Heartbeat's former turn-local selector cannot grant ordinary automation model access. */
export function resolveHeartbeatAutomationModel(cfg: OpenClawConfig, agentId: string) {
  const model = resolveHeartbeatConfig(cfg, agentId)?.model;
  if (!model) {
    return {};
  }
  const defaultModel = resolveConfiguredModelRef({
    cfg,
    agentId,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const selected = resolveAllowedModelRefCore({
    cfg,
    agentId,
    catalog: [],
    defaultProvider: defaultModel.provider,
    defaultModel,
    raw: model,
  });
  if ("error" in selected && selected.error.startsWith("model not allowed:")) {
    const profile = splitTrailingAuthProfile(
      resolveAgentEffectiveModelPrimary(cfg, agentId) ?? "",
    ).profile;
    return {
      fallback: {
        model,
        defaultModel: `${defaultModel.provider}/${defaultModel.model}${profile ? `@${profile}` : ""}`,
      },
    };
  }
  return { model };
}
