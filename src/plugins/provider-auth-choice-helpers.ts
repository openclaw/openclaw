// Normalizes provider auth choice metadata from plugin setup surfaces.
import { isDeepStrictEqual } from "node:util";
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

function isProviderModelRow(value: unknown): value is Record<string, unknown> & { id: string } {
  return isPlainRecord(value) && typeof value.id === "string" && value.id.length > 0;
}

function mergeConfigPatch<T>(
  base: T,
  patch: unknown,
  merge = true,
  options?: { preserveUndefined?: boolean; mergeModelsById?: boolean; source?: unknown },
): T {
  if (
    patch !== undefined &&
    options &&
    Object.hasOwn(options, "source") &&
    isDeepStrictEqual(patch, options.source)
  ) {
    return base;
  }
  if (Array.isArray(patch)) {
    if (
      options?.mergeModelsById &&
      Array.isArray(base) &&
      base.every(isProviderModelRow) &&
      patch.every(isProviderModelRow)
    ) {
      const models = new Map(base.map((model) => [model.id, model]));
      const sourceModels = new Map(
        (Array.isArray(options.source) ? options.source.filter(isProviderModelRow) : []).map(
          (model) => [model.id, model],
        ),
      );
      for (const model of patch) {
        const previous = models.get(model.id);
        models.set(
          model.id,
          previous
            ? mergeConfigPatch(previous, model, true, {
                preserveUndefined: options.preserveUndefined,
                ...(sourceModels.has(model.id) ? { source: sourceModels.get(model.id) } : {}),
              })
            : model,
        );
      }
      // SAFETY: ID folding keeps the config array's row shape; the config owner validates fields.
      return [...models.values()] as T;
    }
    // Replacements are sanitized copies; undefined deletes only during object merging.
    return patch.map((entry) => mergeConfigPatch(undefined, entry, false)) as T;
  }
  if (!isPlainRecord(patch)) {
    return patch as T;
  }

  const next: Record<string, unknown> = merge && isPlainRecord(base) ? { ...base } : {};
  const source = isPlainRecord(options?.source) ? options.source : undefined;
  for (const [key, value] of Object.entries(patch)) {
    if (isBlockedObjectKey(key)) {
      continue;
    }
    if (merge && value === undefined && !options?.preserveUndefined) {
      delete next[key];
      continue;
    }
    next[key] = mergeConfigPatch(
      next[key],
      value,
      merge,
      options && {
        preserveUndefined: options.preserveUndefined,
        mergeModelsById: options.mergeModelsById && key === "models",
        ...(source && Object.hasOwn(source, key) ? { source: source[key] } : {}),
      },
    );
  }
  return next as T;
}

/** Fold auth provider rows without defaults; raw source distinguishes edits from copied config. */
export function normalizeProviderAuthRows<T>(value: T, sourceConfig?: unknown): T {
  if (
    !isPlainRecord(value) ||
    !isPlainRecord(value.models) ||
    !isPlainRecord(value.models.providers)
  ) {
    return value;
  }
  const sourceProviders =
    isPlainRecord(sourceConfig) &&
    isPlainRecord(sourceConfig.models) &&
    isPlainRecord(sourceConfig.models.providers)
      ? sourceConfig.models.providers
      : undefined;
  const rows = Object.entries(value.models.providers)
    .map(([key, row]) => ({ key, row, provider: normalizeProviderId(key) }))
    .toSorted(
      (left, right) => Number(left.key === left.provider) - Number(right.key === right.provider),
    );
  const providers = new Map<string, unknown>(
    sourceProviders
      ? Object.entries(
          normalizeProviderAuthRows({ models: { providers: sourceProviders } }).models.providers,
        )
      : [],
  );
  let changed = Boolean(sourceProviders);
  for (const { key, row, provider } of rows) {
    const duplicate = providers.has(provider);
    changed ||= key !== provider || duplicate;
    // Canonical source rows win; auth edits replay over unchanged copied fields.
    providers.set(
      provider,
      duplicate
        ? mergeConfigPatch(providers.get(provider), row, true, {
            preserveUndefined: true,
            mergeModelsById: true,
            ...(sourceProviders && Object.hasOwn(sourceProviders, key)
              ? { source: sourceProviders[key] }
              : {}),
          })
        : row,
    );
  }
  if (!changed) {
    return value;
  }
  // SAFETY: Only provider record keys/values change; the surrounding config shape is preserved.
  return { ...value, models: { ...value.models, providers: Object.fromEntries(providers) } } as T;
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
    const trimmed = model.id.trim();
    const nextId = trimmed ? normalizeConfiguredProviderCatalogModelId(provider, trimmed) : trimmed;
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

export function applyProviderAuthConfigPatchWithNormalization(
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
    mergeConfigPatch(normalizeProviderAuthRows(cfg), normalizeProviderAuthRows(patch, cfg)),
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

export function restoreAgentsDefaultsModel(
  cfg: OpenClawConfig,
  model: AgentModelConfig | undefined,
): OpenClawConfig {
  const defaults = { ...cfg.agents?.defaults };
  if (model === undefined) {
    delete defaults.model;
  } else {
    defaults.model = model;
  }
  return { ...cfg, agents: { ...cfg.agents, defaults } };
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
  return restoreAgentsDefaultsModel(params.cfg, params.priorAgentsDefaultsModel);
}
