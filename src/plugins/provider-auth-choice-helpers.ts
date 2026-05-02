import { normalizeProviderId } from "../agents/model-selection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
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

function resolveDefaultModelPrimary(model: unknown): string | undefined {
  if (typeof model === "string") {
    return normalizeOptionalString(model);
  }
  if (!isPlainRecord(model)) {
    return undefined;
  }
  return normalizeOptionalString(model.primary);
}

function resolveDefaultModelFallbacks(model: unknown): string[] | undefined {
  if (!isPlainRecord(model) || !Array.isArray(model.fallbacks)) {
    return undefined;
  }
  return model.fallbacks.map((fallback) => String(fallback));
}

function extractPatchedDefaultModel(patch: unknown): unknown {
  if (!isPlainRecord(patch)) {
    return undefined;
  }
  const agents = patch.agents;
  if (!isPlainRecord(agents)) {
    return undefined;
  }
  const defaults = agents.defaults;
  if (!isPlainRecord(defaults) || !Object.prototype.hasOwnProperty.call(defaults, "model")) {
    return undefined;
  }
  return defaults.model;
}

function preserveExistingDefaultModelSelection(
  base: OpenClawConfig,
  merged: OpenClawConfig,
  patch: unknown,
): OpenClawConfig {
  if (extractPatchedDefaultModel(patch) === undefined) {
    return merged;
  }

  const existingModel = base.agents?.defaults?.model;
  const existingPrimary = resolveDefaultModelPrimary(existingModel);
  const existingFallbacks = resolveDefaultModelFallbacks(existingModel);
  if (!existingPrimary && existingFallbacks === undefined) {
    return merged;
  }

  const mergedModel = merged.agents?.defaults?.model;
  const mergedPrimary = resolveDefaultModelPrimary(mergedModel);
  const nextModel = {
    ...(mergedPrimary ? { primary: mergedPrimary } : undefined),
    ...(existingFallbacks !== undefined ? { fallbacks: existingFallbacks } : undefined),
    ...(existingPrimary ? { primary: existingPrimary } : undefined),
  };

  return {
    ...merged,
    agents: {
      ...merged.agents,
      defaults: {
        ...merged.agents?.defaults,
        model: nextModel,
      },
    },
  };
}

export function mergeConfigPatch<T>(base: T, patch: unknown): T {
  const merged = originalMergeConfigPatch(base, patch);
  return preserveExistingDefaultModelSelection(
    base as OpenClawConfig,
    merged as OpenClawConfig,
    patch,
  ) as T;
}

// Placeholder so TypeScript doesn't complain - actual implementation below
function originalMergeConfigPatch<T>(base: T, patch: unknown): T {
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

export function applyProviderAuthConfigPatch(
  cfg: OpenClawConfig,
  patch: unknown,
  options?: { replaceDefaultModels?: boolean; preserveExistingDefaultModel?: boolean },
): OpenClawConfig {
  const merged = mergeConfigPatch(cfg, patch);
  const next =
    options?.preserveExistingDefaultModel === true
      ? preserveExistingDefaultModelSelection(cfg, merged, patch)
      : merged;
  if (!options?.replaceDefaultModels || !isPlainRecord(patch)) {
    return next;
  }

  const patchModels = (patch.agents as { defaults?: { models?: unknown } } | undefined)?.defaults
    ?.models;
  if (!isPlainRecord(patchModels)) {
    return next;
  }

  return {
    ...next,
    agents: {
      ...next.agents,
      defaults: {
        ...next.agents?.defaults,
        // Opt-in replacement for migrations that rename/remove model keys.
        models: sanitizeConfigPatchValue(patchModels) as NonNullable<
          NonNullable<OpenClawConfig["agents"]>["defaults"]
        >["models"],
      },
    },
  };
}

export function applyDefaultModel(
  cfg: OpenClawConfig,
  model: string,
  opts?: { preserveExistingPrimary?: boolean },
): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[model] = models[model] ?? {};

  const existingModel = cfg.agents?.defaults?.model;
  const existingPrimary =
    typeof existingModel === "string"
      ? existingModel
      : existingModel && typeof existingModel === "object"
        ? (existingModel as { primary?: string }).primary
        : undefined;
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...cfg.agents?.defaults,
        models,
        model: {
          ...(existingModel && typeof existingModel === "object" && "fallbacks" in existingModel
            ? { fallbacks: (existingModel as { fallbacks?: string[] }).fallbacks }
            : undefined),
          primary: opts?.preserveExistingPrimary === true ? (existingPrimary ?? model) : model,
        },
      },
    },
  };
}
