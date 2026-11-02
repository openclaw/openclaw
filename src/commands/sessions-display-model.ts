import type { ModelRef } from "../agents/model-ref-shared.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection-config.js";
import {
  inferUniqueProviderFromConfiguredModels,
  isCliProvider,
  normalizeStoredOverrideModel,
  parseModelRef,
  resolvePersistedSelectedModelRef,
  type CliProviderClassifier,
} from "../agents/model-selection.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

/** Resolves provider/model display metadata for a session row. */
export function resolveSessionDisplayModelRef(
  cfg: OpenClawConfig,
  row: Pick<SessionEntry, "model" | "modelProvider" | "modelOverride" | "providerOverride"> & {
    key: string;
  },
  classifyCliProvider: CliProviderClassifier = (provider) => isCliProvider(provider, cfg),
  ownerAgentId?: string,
): ModelRef {
  const agentId =
    ownerAgentId ?? (row.key.startsWith("agent:") ? row.key.split(":")[1] : undefined);
  const defaultRef = resolveDefaultModelForAgent({
    cfg,
    agentId,
    allowManifestNormalization: false,
    allowPluginNormalization: false,
  });
  const normalizedOverride = normalizeStoredOverrideModel({
    providerOverride: row.providerOverride,
    modelOverride: row.modelOverride,
  });
  const persistedRef = resolvePersistedSelectedModelRef({
    defaultProvider: defaultRef.provider,
    runtimeProvider: row.modelProvider,
    runtimeModel: row.model,
    overrideProvider: normalizedOverride.providerOverride,
    overrideModel: normalizedOverride.modelOverride,
    allowManifestNormalization: false,
    allowPluginNormalization: false,
  });
  if (!persistedRef) {
    return defaultRef;
  }
  if (normalizedOverride.modelOverride) {
    return persistedRef;
  }
  if (!classifyCliProvider(persistedRef.provider)) {
    return persistedRef;
  }
  const parsed = parseModelRef(persistedRef.model, defaultRef.provider, {
    allowManifestNormalization: false,
    allowPluginNormalization: false,
  });
  if (persistedRef.model.includes("/") && parsed) {
    // CLI runtimes can store the real provider/model inside the model field;
    // prefer that embedded provider when it is not another CLI runtime alias.
    if (!classifyCliProvider(parsed.provider)) {
      return parsed;
    }
  }
  const inferredProvider = inferUniqueProviderFromConfiguredModels({
    cfg,
    model: persistedRef.model,
    agentId,
  });
  if (inferredProvider && !classifyCliProvider(inferredProvider)) {
    return { provider: inferredProvider, model: persistedRef.model };
  }
  // If the CLI runtime model cannot be mapped to a concrete provider, fall
  // back to the configured default provider so rows stay comparable.
  if (parsed && !classifyCliProvider(parsed.provider)) {
    return parsed;
  }
  return {
    provider: defaultRef.provider || persistedRef.provider,
    model: parsed?.model || persistedRef.model,
  };
}
