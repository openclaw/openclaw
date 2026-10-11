import { asPositiveFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { resolveModelContextTokenProjectionFromCache } from "../agents/context-resolution.js";
import { resolveModelContextTokenProjection } from "../agents/context.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
import { resolveModelContextWindowProfile } from "../agents/model-context-window.js";
import { resolveProjectedSessionContextTokens, type SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Presents capacity from captured facts; runtime selection and admission belong to their owners. */
export function resolveSessionRowContextCapacity(params: {
  cfg: OpenClawConfig;
  provider?: string;
  model: string;
  entry?: SessionEntry;
  runtimeId: string;
  catalogEntry?: ModelCatalogEntry;
}) {
  const {
    cfg,
    provider,
    model,
    entry,
    runtimeId: nativeRuntime,
    catalogEntry: capacityCatalogEntry,
  } = params;
  const contextWindowProfile = resolveModelContextWindowProfile({
    catalogEntry: capacityCatalogEntry,
    selected: entry?.contextWindow,
  });
  const modelContextParams = {
    cfg,
    provider,
    model,
    nativeRuntime,
    modelContextTokens: capacityCatalogEntry?.contextTokens,
    modelContextWindow: contextWindowProfile.contextTokens,
    modelContextWindowSource: contextWindowProfile.contextWindow
      ? undefined
      : capacityCatalogEntry?.contextWindowSource,
    allowAsyncLoad: false,
  };
  const modelContext = capacityCatalogEntry
    ? resolveModelContextTokenProjectionFromCache(
        modelContextParams,
        () => undefined,
        () => undefined,
      )
    : resolveModelContextTokenProjection(modelContextParams);
  const resolvedModelContextTokens = asPositiveFiniteNumber(modelContext.contextTokens);
  const projectedContextTokens = resolveProjectedSessionContextTokens({
    entry,
    provider,
    model,
    agentHarnessId: nativeRuntime,
    resolvedContextTokens:
      modelContext.source === "fallback" ? undefined : resolvedModelContextTokens,
    configuredContextTokenLimits: modelContext.configuredContextTokenLimits,
  });
  const selectedContextTokens = contextWindowProfile.contextWindow
    ? asPositiveFiniteNumber(contextWindowProfile.contextTokens)
    : undefined;
  const contextTokens =
    projectedContextTokens !== undefined && selectedContextTokens !== undefined
      ? Math.min(projectedContextTokens, selectedContextTokens)
      : projectedContextTokens;

  return { contextWindowProfile, contextTokens };
}
