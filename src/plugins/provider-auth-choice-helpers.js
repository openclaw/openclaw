import { normalizeProviderId } from "../agents/model-selection.js";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalLowercaseString, normalizeOptionalString, } from "../shared/string-coerce.js";
export function resolveProviderMatch(providers, rawProvider) {
    const raw = normalizeOptionalString(rawProvider);
    if (!raw) {
        return null;
    }
    const normalized = normalizeProviderId(raw);
    return (providers.find((provider) => normalizeProviderId(provider.id) === normalized) ??
        providers.find((provider) => provider.aliases?.some((alias) => normalizeProviderId(alias) === normalized) ?? false) ??
        null);
}
export function pickAuthMethod(provider, rawMethod) {
    const raw = normalizeOptionalString(rawMethod);
    if (!raw) {
        return null;
    }
    const normalized = normalizeOptionalLowercaseString(raw);
    return (provider.auth.find((method) => normalizeLowercaseStringOrEmpty(method.id) === normalized) ??
        provider.auth.find((method) => normalizeLowercaseStringOrEmpty(method.label) === normalized) ??
        null);
}
function isPlainRecord(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
// Guard config patches against prototype-pollution payloads if a patch ever
// arrives from a JSON-parsed source that preserves these keys.
const BLOCKED_MERGE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
function sanitizeConfigPatchValue(value) {
    if (Array.isArray(value)) {
        return value.map((entry) => sanitizeConfigPatchValue(entry));
    }
    if (!isPlainRecord(value)) {
        return value;
    }
    const next = {};
    for (const [key, nestedValue] of Object.entries(value)) {
        if (BLOCKED_MERGE_KEYS.has(key)) {
            continue;
        }
        next[key] = sanitizeConfigPatchValue(nestedValue);
    }
    return next;
}
export function mergeConfigPatch(base, patch) {
    if (!isPlainRecord(base) || !isPlainRecord(patch)) {
        return sanitizeConfigPatchValue(patch);
    }
    const next = { ...base };
    for (const [key, value] of Object.entries(patch)) {
        if (BLOCKED_MERGE_KEYS.has(key)) {
            continue;
        }
        const existing = next[key];
        if (isPlainRecord(existing) && isPlainRecord(value)) {
            next[key] = mergeConfigPatch(existing, value);
        }
        else {
            next[key] = sanitizeConfigPatchValue(value);
        }
    }
    return next;
}
export function applyProviderAuthConfigPatch(cfg, patch, options) {
    const merged = mergeConfigPatch(cfg, patch);
    if (!options?.replaceDefaultModels || !isPlainRecord(patch)) {
        return merged;
    }
    const patchModels = patch.agents?.defaults
        ?.models;
    if (!isPlainRecord(patchModels)) {
        return merged;
    }
    return {
        ...merged,
        agents: {
            ...merged.agents,
            defaults: {
                ...merged.agents?.defaults,
                // Opt-in replacement for migrations that rename/remove model keys.
                models: sanitizeConfigPatchValue(patchModels),
            },
        },
    };
}
export function applyDefaultModel(cfg, model, opts) {
    const models = { ...cfg.agents?.defaults?.models };
    models[model] = models[model] ?? {};
    const existingModel = cfg.agents?.defaults?.model;
    const existingPrimary = typeof existingModel === "string"
        ? existingModel
        : existingModel && typeof existingModel === "object"
            ? existingModel.primary
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
                        ? { fallbacks: existingModel.fallbacks }
                        : undefined),
                    primary: opts?.preserveExistingPrimary === true ? (existingPrimary ?? model) : model,
                },
            },
        },
    };
}
