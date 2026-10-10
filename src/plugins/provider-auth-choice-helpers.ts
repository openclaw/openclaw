// Normalizes provider auth choice metadata from plugin setup surfaces.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { isRecord as isPlainRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { listAgentEntries, toAgentEntriesRecord } from "../agents/agent-scope-config.js";
import { normalizeConfiguredProviderCatalogModelId } from "../agents/model-ref-shared.js";
import {
  normalizeAgentModelMapForConfig,
  normalizeAgentModelRefForConfig,
  normalizeAgentModelSelectionForConfig,
} from "../config/model-input.js";
import { normalizeProviderConfigForConfigDefaults } from "../config/provider-policy.js";
import type { AgentModelConfig } from "../config/types.agents-shared.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import type { ProviderAuthMethod, ProviderPlugin } from "./types.js";

export function resolveProviderMatch(
  providers: ProviderPlugin[],
  rawProvider?: string,
): ProviderPlugin | null {
  const raw = normalizeOptionalString(rawProvider);
  if (!raw) {
    return null;
  }
  const normalized = normalizeProviderId(raw);
  return (
    providers.find((provider) => normalizeProviderId(provider.id) === normalized) ??
    providers.find(
      (provider) =>
        provider.aliases?.some((alias) => normalizeProviderId(alias) === normalized) ?? false,
    ) ??
    null
  );
}

export function pickAuthMethod(
  provider: ProviderPlugin,
  rawMethod?: string,
): ProviderAuthMethod | null {
  const normalized = normalizeOptionalLowercaseString(rawMethod);
  if (!normalized) {
    return null;
  }
  return (
    provider.auth.find((method) => normalizeLowercaseStringOrEmpty(method.id) === normalized) ??
    provider.auth.find((method) => normalizeLowercaseStringOrEmpty(method.label) === normalized) ??
    null
  );
}

function mergeConfigPatch<T>(base: T, patch: unknown, merge = true): T {
  if (Array.isArray(patch)) {
    // Replacements are sanitized copies; undefined deletes only during object merging.
    return patch.map((entry) => mergeConfigPatch(undefined, entry, false)) as T;
  }
  if (!isPlainRecord(patch)) {
    return patch as T;
  }

  const next: Record<string, unknown> = merge && isPlainRecord(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (isBlockedObjectKey(key)) {
      continue;
    }
    if (merge && value === undefined) {
      delete next[key];
      continue;
    }
    next[key] = mergeConfigPatch(next[key], value, merge);
  }
  return next as T;
}

function normalizeAgentModelConfigForWrite(value: unknown): unknown {
  const normalized = normalizeAgentModelSelectionForConfig(value);
  if (!isPlainRecord(normalized)) {
    return normalized;
  }
  // Provider patches own their model copy even when normalization changes no values.
  return {
    ...normalized,
    ...(Array.isArray(normalized.fallbacks) ? { fallbacks: [...normalized.fallbacks] } : {}),
  };
}

function normalizeAgentModelMapForWrite(value: unknown): unknown {
  if (!isPlainRecord(value)) {
    return value;
  }
  return normalizeAgentModelMapForConfig(value);
}

function normalizeAgentModelPolicyForWrite(value: unknown): unknown {
  if (!isPlainRecord(value) || !Array.isArray(value.allow)) {
    return value;
  }
  return {
    ...value,
    allow: value.allow.map((ref) =>
      typeof ref === "string" ? normalizeAgentModelRefForConfig(ref) : ref,
    ),
  };
}

function normalizeProviderCatalogModelIdForWrite(provider: string, modelId: string): string {
  const trimmed = modelId.trim();
  if (!trimmed) {
    return trimmed;
  }
  return normalizeConfiguredProviderCatalogModelId(normalizeProviderId(provider), trimmed);
}

function normalizeArray<T>(values: T[], normalize: (value: T) => T): T[] {
  let changed = false;
  const next = values.map((value) => {
    const normalized = normalize(value);
    changed ||= normalized !== value;
    return normalized;
  });
  return changed ? next : values;
}

function normalizeProviderCatalogModelIdsForWrite(
  provider: string,
  providerConfig: ModelProviderConfig,
): ModelProviderConfig {
  const models = providerConfig.models;
  if (!Array.isArray(models) || models.length === 0) {
    return providerConfig;
  }

  const nextModels = normalizeArray(models, (model) => {
    const nextId = normalizeProviderCatalogModelIdForWrite(provider, model.id);
    return nextId === model.id ? model : Object.assign({}, model, { id: nextId });
  });

  return nextModels === models ? providerConfig : { ...providerConfig, models: nextModels };
}

function normalizeModelProviderConfigsForWrite(
  cfg: OpenClawConfig,
  providerConfigNormalizer: typeof normalizeProviderConfigForConfigDefaults,
): OpenClawConfig {
  const providers = cfg.models?.providers;
  if (!providers) {
    return cfg;
  }

  let mutated = false;
  const nextProviders = { ...providers };
  for (const [provider, providerConfig] of Object.entries(providers)) {
    const normalizedProviderConfig = normalizeProviderCatalogModelIdsForWrite(
      provider,
      providerConfigNormalizer({
        provider,
        providerConfig,
      }),
    );
    if (normalizedProviderConfig === providerConfig) {
      continue;
    }
    nextProviders[provider] = normalizedProviderConfig;
    mutated = true;
  }

  if (!mutated) {
    return cfg;
  }

  return {
    ...cfg,
    models: {
      ...cfg.models,
      providers: nextProviders,
    },
  };
}

const AGENT_MODEL_NORMALIZERS = {
  model: normalizeAgentModelConfigForWrite,
  models: normalizeAgentModelMapForWrite,
  modelPolicy: normalizeAgentModelPolicyForWrite,
};

function normalizeAgentModelFields<
  T extends { model?: unknown; models?: unknown; modelPolicy?: unknown },
>(value: T, defaults: boolean): T {
  let next = defaults ? { ...value } : value;
  for (const key of ["model", "models", "modelPolicy"] as const) {
    // Defaults retain their unconditional copy; agent entries preserve absence and identity.
    if (defaults ? value[key] !== undefined : Object.hasOwn(value, key)) {
      const normalized = AGENT_MODEL_NORMALIZERS[key](value[key]);
      if (defaults || normalized !== value[key]) {
        if (next === value) {
          next = { ...value };
        }
        Object.assign(next, { [key]: normalized });
      }
    }
  }
  return next;
}

function normalizeConfigModelRefsForWrite(
  cfg: OpenClawConfig,
  providerConfigNormalizer: typeof normalizeProviderConfigForConfigDefaults,
): OpenClawConfig {
  const providerNormalized = normalizeModelProviderConfigsForWrite(cfg, providerConfigNormalizer);
  const defaults = providerNormalized.agents?.defaults;
  const agentsList = listAgentEntries(providerNormalized);

  const nextDefaults = defaults && normalizeAgentModelFields(defaults, true);

  const nextAgentsList = normalizeArray(agentsList, (agent) =>
    isPlainRecord(agent) ? normalizeAgentModelFields(agent, false) : agent,
  );
  if (nextDefaults === defaults && nextAgentsList === agentsList) {
    return providerNormalized;
  }

  return {
    ...providerNormalized,
    agents: {
      ...providerNormalized.agents,
      ...(nextDefaults ? { defaults: nextDefaults } : {}),
      ...(nextAgentsList !== agentsList ? { entries: toAgentEntriesRecord(nextAgentsList) } : {}),
    },
  };
}

export function applyProviderAuthConfigPatch(
  cfg: OpenClawConfig,
  patch: unknown,
  options?: {
    replaceDefaultModels?: boolean;
    providerConfigNormalizer?: typeof normalizeProviderConfigForConfigDefaults;
  },
): OpenClawConfig {
  const providerConfigNormalizer =
    options?.providerConfigNormalizer ?? normalizeProviderConfigForConfigDefaults;
  const merged = normalizeConfigModelRefsForWrite(
    mergeConfigPatch(cfg, patch),
    providerConfigNormalizer,
  );
  if (!options?.replaceDefaultModels || !isPlainRecord(patch)) {
    return merged;
  }

  const patchModels = (patch.agents as { defaults?: { models?: unknown } } | undefined)?.defaults
    ?.models;
  if (!isPlainRecord(patchModels)) {
    return merged;
  }

  return normalizeConfigModelRefsForWrite(
    {
      ...merged,
      agents: {
        ...merged.agents,
        defaults: {
          ...merged.agents?.defaults,
          // Opt-in replacement for migrations that rename/remove model keys.
          models: mergeConfigPatch({}, patchModels, false) as NonNullable<
            NonNullable<OpenClawConfig["agents"]>["defaults"]
          >["models"],
        },
      },
    },
    providerConfigNormalizer,
  );
}

/**
 * Restore `agents.defaults.model`, including its absence, after a provider auth config merge when
 * the user did not pass `--set-default`.
 */
export function restorePriorAgentsDefaultsModelUnlessOptIn(params: {
  cfg: OpenClawConfig;
  priorAgentsDefaultsModel?: AgentModelConfig;
  setDefault?: boolean;
}): OpenClawConfig {
  if (params.setDefault) {
    return params.cfg;
  }
  if (
    params.priorAgentsDefaultsModel === undefined &&
    params.cfg.agents?.defaults?.model === undefined
  ) {
    return params.cfg;
  }
  const defaults = { ...params.cfg.agents?.defaults };
  if (params.priorAgentsDefaultsModel === undefined) {
    delete defaults.model;
  } else {
    defaults.model = params.priorAgentsDefaultsModel;
  }
  return {
    ...params.cfg,
    agents: {
      ...params.cfg.agents,
      defaults,
    },
  };
}
