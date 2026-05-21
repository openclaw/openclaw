import { normalizeConfiguredProviderCatalogModelId } from "../agents/model-ref-shared.js";
import { normalizeProviderId } from "../agents/model-selection.js";
import {
  normalizeAgentModelMapForConfig,
  normalizeAgentModelRefForConfig,
} from "../config/model-input.js";
import { normalizeProviderConfigForConfigDefaults } from "../config/provider-policy.js";
import type { AgentModelConfig } from "../config/types.agents-shared.js";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import type { ProviderAuthMethod, ProviderPlugin } from "./types.js";

type ConfigPatchDiff =
  | { changed: false }
  | {
      changed: true;
      value: unknown;
    };

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
  const raw = normalizeOptionalString(rawMethod);
  if (!raw) {
    return null;
  }
  const normalized = normalizeOptionalLowercaseString(raw);
  return (
    provider.auth.find((method) => normalizeLowercaseStringOrEmpty(method.id) === normalized) ??
    provider.auth.find((method) => normalizeLowercaseStringOrEmpty(method.label) === normalized) ??
    null
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

// Guard config patches against prototype-pollution payloads if a patch ever
// arrives from a JSON-parsed source that preserves these keys.
const BLOCKED_MERGE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function sanitizeConfigPatchValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeConfigPatchValue(entry));
  }
  if (!isPlainRecord(value)) {
    return value;
  }

  const next: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (BLOCKED_MERGE_KEYS.has(key)) {
      continue;
    }
    next[key] = sanitizeConfigPatchValue(nestedValue);
  }
  return next;
}

function mergeConfigPatch<T>(base: T, patch: unknown): T {
  if (!isPlainRecord(base) || !isPlainRecord(patch)) {
    return sanitizeConfigPatchValue(patch) as T;
  }

  const next: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (BLOCKED_MERGE_KEYS.has(key)) {
      continue;
    }
    const existing = next[key];
    if (isPlainRecord(existing) && isPlainRecord(value)) {
      next[key] = mergeConfigPatch(existing, value);
    } else {
      next[key] = sanitizeConfigPatchValue(value);
    }
  }
  return next as T;
}

function diffConfigPatchValue(base: unknown, next: unknown): ConfigPatchDiff {
  if (Object.is(base, next)) {
    return { changed: false };
  }
  if (Array.isArray(base) && Array.isArray(next)) {
    if (
      base.length === next.length &&
      next.every((value, index) => !diffConfigPatchValue(base[index], value).changed)
    ) {
      return { changed: false };
    }
    return { changed: true, value: sanitizeConfigPatchValue(next) };
  }
  if (!isPlainRecord(base) || !isPlainRecord(next)) {
    return { changed: true, value: sanitizeConfigPatchValue(next) };
  }

  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(next)) {
    if (BLOCKED_MERGE_KEYS.has(key)) {
      continue;
    }
    const diff = diffConfigPatchValue(base[key], next[key]);
    if (diff.changed) {
      patch[key] = diff.value;
    }
  }
  return Object.keys(patch).length > 0 ? { changed: true, value: patch } : { changed: false };
}

function withDefaultModelsReplacementPatch(params: {
  patch: Partial<OpenClawConfig> | undefined;
  nextConfig: OpenClawConfig;
  replaceDefaultModels?: boolean;
}): Partial<OpenClawConfig> | undefined {
  if (!params.replaceDefaultModels) {
    return params.patch;
  }
  const replacementModels = params.nextConfig.agents?.defaults?.models;
  if (!replacementModels) {
    return params.patch;
  }
  const patch = params.patch ?? {};
  const patchAgents = isPlainRecord(patch.agents) ? patch.agents : {};
  const patchDefaults = isPlainRecord(patchAgents.defaults) ? patchAgents.defaults : {};
  return {
    ...patch,
    agents: {
      ...patchAgents,
      defaults: {
        ...patchDefaults,
        models: sanitizeConfigPatchValue(replacementModels) as NonNullable<
          NonNullable<OpenClawConfig["agents"]>["defaults"]
        >["models"],
      },
    },
  };
}

export function buildMinimalProviderAuthConfigPatch(params: {
  baseConfig: OpenClawConfig;
  nextConfig: OpenClawConfig;
  replaceDefaultModels?: boolean;
}): Partial<OpenClawConfig> | undefined {
  const diff = diffConfigPatchValue(params.baseConfig, params.nextConfig);
  const patch =
    diff.changed && isPlainRecord(diff.value) ? (diff.value as Partial<OpenClawConfig>) : undefined;
  return withDefaultModelsReplacementPatch({
    patch,
    nextConfig: params.nextConfig,
    replaceDefaultModels: params.replaceDefaultModels,
  });
}

function normalizeAgentModelConfigForWrite(value: unknown): unknown {
  if (typeof value === "string") {
    return normalizeAgentModelRefForConfig(value);
  }
  if (!isPlainRecord(value)) {
    return value;
  }

  const next: Record<string, unknown> = { ...value };
  if (typeof next.primary === "string") {
    next.primary = normalizeAgentModelRefForConfig(next.primary);
  }
  if (Array.isArray(next.fallbacks)) {
    next.fallbacks = next.fallbacks.map((fallback) =>
      typeof fallback === "string" ? normalizeAgentModelRefForConfig(fallback) : fallback,
    );
  }
  return next;
}

function normalizeAgentModelMapForWrite(value: unknown): unknown {
  if (!isPlainRecord(value)) {
    return value;
  }
  return normalizeAgentModelMapForConfig(value);
}

function normalizeProviderCatalogModelIdForWrite(provider: string, modelId: string): string {
  const trimmed = modelId.trim();
  if (!trimmed) {
    return trimmed;
  }
  return normalizeConfiguredProviderCatalogModelId(normalizeProviderId(provider), trimmed);
}

function normalizeProviderCatalogModelIdsForWrite(
  provider: string,
  providerConfig: ModelProviderConfig,
): ModelProviderConfig {
  const models = providerConfig.models;
  if (!Array.isArray(models) || models.length === 0) {
    return providerConfig;
  }

  let mutated = false;
  const nextModels = models.map((model) => {
    const nextId = normalizeProviderCatalogModelIdForWrite(provider, model.id);
    if (nextId === model.id) {
      return model;
    }
    mutated = true;
    return Object.assign({}, model, { id: nextId });
  });

  return mutated ? { ...providerConfig, models: nextModels } : providerConfig;
}

function normalizeModelProviderConfigsForWrite(cfg: OpenClawConfig): OpenClawConfig {
  const providers = cfg.models?.providers;
  if (!providers) {
    return cfg;
  }

  let mutated = false;
  const nextProviders = { ...providers };
  for (const [provider, providerConfig] of Object.entries(providers)) {
    const normalizedProviderConfig = normalizeProviderCatalogModelIdsForWrite(
      provider,
      normalizeProviderConfigForConfigDefaults({
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

function normalizeAgentListForWrite(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }

  let mutated = false;
  const next = value.map((agent) => {
    if (!isPlainRecord(agent)) {
      return agent;
    }

    let nextAgent = agent;
    if (Object.prototype.hasOwnProperty.call(agent, "model")) {
      const normalizedModel = normalizeAgentModelConfigForWrite(agent.model);
      if (normalizedModel !== agent.model) {
        nextAgent = { ...nextAgent, model: normalizedModel };
        mutated = true;
      }
    }
    if (Object.prototype.hasOwnProperty.call(agent, "models")) {
      const normalizedModels = normalizeAgentModelMapForWrite(agent.models);
      if (normalizedModels !== agent.models) {
        nextAgent = { ...nextAgent, models: normalizedModels };
        mutated = true;
      }
    }
    return nextAgent;
  });

  return mutated ? next : value;
}

function normalizeConfigModelRefsForWrite(cfg: OpenClawConfig): OpenClawConfig {
  const providerNormalized = normalizeModelProviderConfigsForWrite(cfg);
  const defaults = providerNormalized.agents?.defaults;
  const agentsList = providerNormalized.agents?.list;

  let nextDefaults = defaults;
  if (defaults) {
    nextDefaults = { ...defaults };
    if (defaults.model !== undefined) {
      nextDefaults.model = normalizeAgentModelConfigForWrite(
        defaults.model,
      ) as typeof defaults.model;
    }
    if (defaults.models !== undefined) {
      nextDefaults.models = normalizeAgentModelMapForWrite(
        defaults.models,
      ) as typeof defaults.models;
    }
  }

  const nextAgentsList = normalizeAgentListForWrite(agentsList);
  if (nextDefaults === defaults && nextAgentsList === agentsList) {
    return providerNormalized;
  }

  return {
    ...providerNormalized,
    agents: {
      ...providerNormalized.agents,
      ...(nextDefaults ? { defaults: nextDefaults } : {}),
      ...(nextAgentsList !== undefined ? { list: nextAgentsList as typeof agentsList } : {}),
    },
  };
}

export function applyProviderAuthConfigPatch(
  cfg: OpenClawConfig,
  patch: unknown,
  options?: { replaceDefaultModels?: boolean },
): OpenClawConfig {
  const merged = normalizeConfigModelRefsForWrite(mergeConfigPatch(cfg, patch));
  if (!options?.replaceDefaultModels || !isPlainRecord(patch)) {
    return merged;
  }

  const patchModels = (patch.agents as { defaults?: { models?: unknown } } | undefined)?.defaults
    ?.models;
  if (!isPlainRecord(patchModels)) {
    return merged;
  }

  return normalizeConfigModelRefsForWrite({
    ...merged,
    agents: {
      ...merged.agents,
      defaults: {
        ...merged.agents?.defaults,
        // Opt-in replacement for migrations that rename/remove model keys.
        models: sanitizeConfigPatchValue(patchModels) as NonNullable<
          NonNullable<OpenClawConfig["agents"]>["defaults"]
        >["models"],
      },
    },
  });
}

export function restoreConfiguredPrimaryModel(
  nextConfig: OpenClawConfig,
  originalConfig: OpenClawConfig,
): OpenClawConfig {
  const originalModel = originalConfig.agents?.defaults?.model;
  const nextAgents = nextConfig.agents;
  const nextDefaults = nextAgents?.defaults;
  if (!nextDefaults) {
    return nextConfig;
  }
  if (originalModel !== undefined) {
    return {
      ...nextConfig,
      agents: {
        ...nextAgents,
        defaults: {
          ...nextDefaults,
          model: originalModel,
        },
      },
    };
  }
  const { model: _model, ...restDefaults } = nextDefaults;
  return {
    ...nextConfig,
    agents: {
      ...nextAgents,
      defaults: restDefaults,
    },
  };
}

/**
 * Restore `agents.defaults.model` after a provider auth config merge when the user did not pass
 * `--set-default`, so `applyConfig` patches cannot replace the primary without an explicit opt-in.
 */
export function restorePriorAgentsDefaultsModelUnlessOptIn(params: {
  cfg: OpenClawConfig;
  priorAgentsDefaultsModel?: AgentModelConfig;
  setDefault?: boolean;
}): OpenClawConfig {
  if (params.setDefault || params.priorAgentsDefaultsModel === undefined) {
    return params.cfg;
  }
  return {
    ...params.cfg,
    agents: {
      ...params.cfg.agents,
      defaults: {
        ...params.cfg.agents?.defaults,
        model: params.priorAgentsDefaultsModel,
      },
    },
  };
}

export function applyDefaultModel(
  cfg: OpenClawConfig,
  model: string,
  opts?: { preserveExistingPrimary?: boolean },
): OpenClawConfig {
  const normalizedModel = normalizeAgentModelRefForConfig(model);
  const models = {
    ...normalizeAgentModelMapForConfig(cfg.agents?.defaults?.models ?? {}),
  };
  models[normalizedModel] = models[normalizedModel] ?? {};

  const existingModel = cfg.agents?.defaults?.model;
  const existingPrimary =
    typeof existingModel === "string"
      ? existingModel
      : existingModel && typeof existingModel === "object"
        ? (existingModel as { primary?: string }).primary
        : undefined;
  const normalizedExistingPrimary = existingPrimary
    ? normalizeAgentModelRefForConfig(existingPrimary)
    : undefined;
  const existingFallbacks =
    existingModel && typeof existingModel === "object" && "fallbacks" in existingModel
      ? (existingModel as { fallbacks?: string[] }).fallbacks?.map((fallback) =>
          normalizeAgentModelRefForConfig(fallback),
        )
      : undefined;
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        models,
        model: {
          ...(existingFallbacks ? { fallbacks: existingFallbacks } : undefined),
          primary:
            opts?.preserveExistingPrimary === true
              ? (normalizedExistingPrimary ?? normalizedModel)
              : normalizedModel,
        },
      },
    },
  };
}
