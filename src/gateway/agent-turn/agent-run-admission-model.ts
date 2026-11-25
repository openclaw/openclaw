import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  NO_MODEL_CONFIGURED_MESSAGE,
  resolvePersistedOverrideModelRef,
} from "../../agents/model-selection.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import { resolveEffectiveAgentRuntime } from "../../agents/thinking-runtime.js";
import { resolveGatewaySessionTurnModelRef } from "../session-utils-store-lineage.js";
import type { PrepareAgentRunDispatchParams } from "./agent-run-admission-types.js";

/** Resolves the run's model; with none configured, rejects the request and returns undefined. */
export async function resolveAgentRunAdmissionModel(
  params: Pick<
    PrepareAgentRunDispatchParams,
    | "cfg"
    | "cfgForAgent"
    | "sessionEntry"
    | "resolvedSessionKey"
    | "activeSessionAgentId"
    | "providerOverride"
    | "modelOverride"
    | "allowModelOverride"
    | "lifecycleStorePath"
  > & {
    request: Pick<PrepareAgentRunDispatchParams["request"], "thinking">;
    io: Pick<PrepareAgentRunDispatchParams["io"], "emitAcceptance">;
  },
) {
  const effectiveProviderOverride = params.providerOverride;
  const effectiveModelOverride = params.modelOverride;
  const effectiveThinking = params.request.thinking;
  const effectiveAllowModelOverride = params.allowModelOverride;
  const runtimeConfig = params.cfgForAgent ?? params.cfg;
  // A request naming both provider and model never consults the session's selection.
  const sessionModel =
    effectiveProviderOverride?.trim() && effectiveModelOverride?.trim()
      ? undefined
      : await resolveGatewaySessionTurnModelRef({
          cfg: runtimeConfig,
          agentId: params.activeSessionAgentId,
          sessionKey: params.resolvedSessionKey,
          entry: params.sessionEntry,
        });
  const activeModel = effectiveModelOverride
    ? (resolvePersistedOverrideModelRef({
        defaultProvider: effectiveProviderOverride ?? sessionModel?.provider,
        overrideProvider: effectiveProviderOverride,
        overrideModel: effectiveModelOverride,
      }) ?? sessionModel)
    : sessionModel && {
        provider: effectiveProviderOverride ?? sessionModel.provider,
        model: sessionModel.model,
      };
  if (!activeModel) {
    params.io.emitAcceptance([
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, NO_MODEL_CONFIGURED_MESSAGE),
    ]);
    return undefined;
  }
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
    resolvedRuntime,
    providerFacts: {
      providerId: activeModel.provider,
      authProviderId: resolveProviderIdForAuth(activeModel.provider, { config: runtimeConfig }),
    },
    modelSelection: {
      effectiveProviderOverride,
      effectiveModelOverride,
      effectiveThinking,
      effectiveAllowModelOverride,
      lifecycleStorePath: params.lifecycleStorePath,
    },
  };
}
