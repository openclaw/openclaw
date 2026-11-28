import { resolveAgentEffectiveModelPrimary } from "../agents/agent-scope.js";
import { DEFAULT_PROVIDER } from "../agents/defaults.js";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import { resolveAllowedModelRefCore } from "../agents/model-selection-resolve.js";
import { resolveConfiguredModelRef } from "../agents/model-selection-shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveLegacyHeartbeatConfig } from "./doctor-heartbeat-legacy.js";

/** Heartbeat's former turn-local selector cannot grant ordinary automation model access. */
export function resolveHeartbeatAutomationModel(cfg: OpenClawConfig, agentId: string) {
  const model = resolveLegacyHeartbeatConfig(cfg, agentId)?.model;
  if (!model) {
    return {};
  }
  const defaultModel = resolveConfiguredModelRef({
    cfg,
    agentId,
    defaultProvider: DEFAULT_PROVIDER,
  });
  const selected = resolveAllowedModelRefCore({
    cfg,
    agentId,
    catalog: [],
    defaultProvider: defaultModel?.provider ?? DEFAULT_PROVIDER,
    defaultModel,
    raw: model,
  });
  if ("error" in selected && selected.error.startsWith("model not allowed:")) {
    if (!defaultModel) {
      // A disallowed selector with no configured model has nothing allowed to fall back to.
      return {};
    }
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
