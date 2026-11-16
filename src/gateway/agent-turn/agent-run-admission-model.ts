import { resolvePersistedOverrideModelRef } from "../../agents/model-selection.js";
import { resolveEffectiveAgentRuntime } from "../../agents/thinking-runtime.js";
import { resolveSessionModelRef } from "../session-utils.js";
import type { PrepareAgentRunDispatchParams } from "./agent-run-admission-types.js";

export function resolveAgentRunAdmissionModel(params: PrepareAgentRunDispatchParams) {
  const effectiveProviderOverride = params.providerOverride;
  const effectiveModelOverride = params.modelOverride;
  const effectiveThinking = params.request.thinking;
  const effectiveAllowModelOverride = params.allowModelOverride;
  const runtimeConfig = params.cfgForAgent ?? params.cfg;
  const sessionModel = resolveSessionModelRef(
    runtimeConfig,
    params.sessionEntry,
    params.activeSessionAgentId,
  );
  const activeModel = effectiveModelOverride
    ? (resolvePersistedOverrideModelRef({
        defaultProvider: effectiveProviderOverride ?? sessionModel.provider,
        overrideProvider: effectiveProviderOverride,
        overrideModel: effectiveModelOverride,
      }) ?? sessionModel)
    : {
        provider: effectiveProviderOverride ?? sessionModel.provider,
        model: sessionModel.model,
      };
  const resolvedRuntime = {
    harness: resolveEffectiveAgentRuntime({
      cfg: runtimeConfig,
      provider: activeModel.provider,
      modelId: activeModel.model,
      agentId: params.activeSessionAgentId,
      sessionKey: params.resolvedSessionKey,
      sessionEntry: params.sessionEntry,
    }),
    provider: activeModel.provider,
    model: activeModel.model,
  };
  return {
    effectiveProviderOverride,
    effectiveModelOverride,
    effectiveThinking,
    effectiveAllowModelOverride,
    resolvedRuntime,
    lifecycleStorePath: params.lifecycleStorePath,
  };
}
