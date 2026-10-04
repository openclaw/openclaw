import { resolveEffectiveModelFallbacks } from "../agents/agent-scope.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection-config.js";
import { resolveSessionRuntimeOverrideForProvider } from "../agents/session-runtime-compat.js";
import { resolveSessionModelOverrideSource } from "../config/sessions/model-override-provenance.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveDirectStoredModelOverride } from "../sessions/stored-model-overrides.js";

/** Select the current chat's route without treating historical execution metadata as a pin. */
export function resolveConsultSessionModelSelection(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  sessionEntry: SessionEntry;
}) {
  const defaultModel = resolveDefaultModelForAgent(params);
  const override = resolveDirectStoredModelOverride({
    sessionEntry: params.sessionEntry,
    defaultProvider: defaultModel.provider,
  });
  const provider = override?.provider ?? defaultModel.provider;
  return {
    provider,
    model: override?.model ?? defaultModel.model,
    requestedRouteResolution: override?.routeResolution ?? ("resolved" as const),
    agentHarnessRuntimeOverride: resolveSessionRuntimeOverrideForProvider({
      cfg: params.cfg,
      provider,
      entry: params.sessionEntry,
    }),
    modelFallbacksOverride: resolveEffectiveModelFallbacks({
      cfg: params.cfg,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      subagentSpawnLineage: (params.sessionEntry.spawnDepth ?? 0) > 0,
      hasSessionModelOverride: override !== null,
      modelOverrideSource: resolveSessionModelOverrideSource(params.sessionEntry) ?? undefined,
    }),
  };
}
