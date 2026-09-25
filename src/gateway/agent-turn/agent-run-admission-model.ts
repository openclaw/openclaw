import { resolvePersistedOverrideModelRef } from "../../agents/model-selection.js";
import { resolveEffectiveAgentRuntime } from "../../agents/thinking-runtime.js";
import { resolveSessionModelRef } from "../session-utils.js";
import type { PrepareAgentRunDispatchParams } from "./agent-run-admission-types.js";

export function resolveAgentRunAdmissionModel(
  params: Pick<
    PrepareAgentRunDispatchParams,
    | "cfgForAgent"
    | "cfg"
    | "sessionEntry"
    | "activeSessionAgentId"
    | "resolvedSessionKey"
    | "providerOverride"
    | "modelOverride"
  >,
) {
  const runtimeConfig = params.cfgForAgent ?? params.cfg;
  const { providerOverride, modelOverride } = params;
  const sessionModel = resolveSessionModelRef(
    runtimeConfig,
    params.sessionEntry,
    params.activeSessionAgentId,
  );
  const activeModel = modelOverride
    ? (resolvePersistedOverrideModelRef({
        defaultProvider: providerOverride ?? sessionModel.provider,
        overrideProvider: providerOverride,
        overrideModel: modelOverride,
      }) ?? sessionModel)
    : {
        provider: providerOverride ?? sessionModel.provider,
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
  return { activeModel, resolvedRuntime };
}
