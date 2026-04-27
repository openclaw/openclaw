import { normalizeProviderId } from "../agents/provider-id.js";
import { BASE_THINKING_LEVELS, normalizeThinkLevel, resolveThinkingDefaultForModel as resolveThinkingDefaultForModelFallback, THINKING_LEVEL_RANKS, } from "./thinking.shared.js";
export { formatXHighModelHint, normalizeElevatedLevel, normalizeFastMode, normalizeNoticeLevel, normalizeReasoningLevel, normalizeTraceLevel, normalizeThinkLevel, normalizeUsageDisplay, normalizeVerboseLevel, resolveResponseUsageMode, resolveElevatedMode, } from "./thinking.shared.js";
import { resolveProviderBinaryThinking, resolveProviderDefaultThinkingLevel, resolveProviderThinkingProfile, resolveProviderXHighThinking, } from "../plugins/provider-thinking.js";
import { normalizeOptionalLowercaseString, normalizeOptionalString, } from "../shared/string-coerce.js";
function resolveThinkingPolicyContext(params) {
    const providerRaw = normalizeOptionalString(params.provider);
    const normalizedProvider = providerRaw ? normalizeProviderId(providerRaw) : "";
    const modelId = normalizeOptionalString(params.model) ?? "";
    const modelKey = normalizeOptionalLowercaseString(params.model) ?? "";
    const candidate = params.catalog?.find((entry) => normalizeProviderId(entry.provider) === normalizedProvider && entry.id === modelId);
    return { normalizedProvider, modelId, modelKey, reasoning: candidate?.reasoning };
}
function normalizeProfileLevel(level) {
    const normalized = normalizeThinkLevel(level.id);
    if (!normalized) {
        return undefined;
    }
    return {
        id: normalized,
        label: normalizeOptionalString(level.label) ?? normalized,
        rank: Number.isFinite(level.rank) ? level.rank : THINKING_LEVEL_RANKS[normalized],
    };
}
function normalizeThinkingProfile(profile) {
    const byId = new Map();
    for (const raw of profile.levels) {
        const level = normalizeProfileLevel(raw);
        if (level) {
            byId.set(level.id, level);
        }
    }
    const levels = [...byId.values()].toSorted((a, b) => a.rank - b.rank);
    const rawDefaultLevel = profile.defaultLevel
        ? normalizeThinkLevel(profile.defaultLevel)
        : undefined;
    const defaultLevel = rawDefaultLevel && byId.has(rawDefaultLevel) ? rawDefaultLevel : undefined;
    return { levels, defaultLevel };
}
function buildBaseThinkingProfile(defaultLevel) {
    return {
        levels: BASE_THINKING_LEVELS.map((id) => ({
            id,
            label: id,
            rank: THINKING_LEVEL_RANKS[id],
        })),
        defaultLevel,
    };
}
function buildBinaryThinkingProfile(defaultLevel) {
    return {
        levels: [
            { id: "off", label: "off", rank: THINKING_LEVEL_RANKS.off },
            { id: "low", label: "on", rank: THINKING_LEVEL_RANKS.low },
        ],
        defaultLevel,
    };
}
function appendProfileLevel(profile, id) {
    if (profile.levels.some((level) => level.id === id)) {
        return;
    }
    profile.levels.push({ id, label: id, rank: THINKING_LEVEL_RANKS[id] });
    profile.levels = profile.levels.toSorted((a, b) => a.rank - b.rank);
}
export function resolveThinkingProfile(params) {
    const context = resolveThinkingPolicyContext(params);
    if (!context.normalizedProvider) {
        return buildBaseThinkingProfile();
    }
    const providerContext = {
        provider: context.normalizedProvider,
        modelId: context.modelId,
        reasoning: context.reasoning,
    };
    const pluginProfile = resolveProviderThinkingProfile({
        provider: context.normalizedProvider,
        context: providerContext,
    });
    if (pluginProfile) {
        const normalized = normalizeThinkingProfile(pluginProfile);
        if (normalized.levels.length > 0) {
            return normalized;
        }
    }
    const defaultLevel = resolveProviderDefaultThinkingLevel({
        provider: context.normalizedProvider,
        context: providerContext,
    });
    const binaryDecision = resolveProviderBinaryThinking({
        provider: context.normalizedProvider,
        context: {
            provider: context.normalizedProvider,
            modelId: context.modelId,
        },
    });
    const profile = binaryDecision === true
        ? buildBinaryThinkingProfile(defaultLevel)
        : buildBaseThinkingProfile(defaultLevel);
    const policyContext = {
        provider: context.normalizedProvider,
        modelId: context.modelKey || context.modelId,
    };
    if (resolveProviderXHighThinking({
        provider: context.normalizedProvider,
        context: policyContext,
    }) === true) {
        appendProfileLevel(profile, "xhigh");
    }
    return profile;
}
export function isBinaryThinkingProvider(provider, model) {
    const profile = resolveThinkingProfile({ provider, model });
    return profile.levels.length === 2 && profile.levels.some((level) => level.label === "on");
}
function supportsThinkingLevel(provider, model, level) {
    return resolveThinkingProfile({ provider, model }).levels.some((entry) => entry.id === level);
}
export function supportsXHighThinking(provider, model) {
    return supportsThinkingLevel(provider, model, "xhigh");
}
export function listThinkingLevels(provider, model) {
    const profile = resolveThinkingProfile({ provider, model });
    return profile.levels.map((level) => level.id);
}
export function listThinkingLevelOptions(provider, model) {
    const profile = resolveThinkingProfile({ provider, model });
    return profile.levels.map(({ id, label }) => ({ id, label }));
}
export function listThinkingLevelLabels(provider, model) {
    return listThinkingLevelOptions(provider, model).map((level) => level.label);
}
export function formatThinkingLevels(provider, model, separator = ", ") {
    return listThinkingLevelLabels(provider, model).join(separator);
}
export function resolveThinkingDefaultForModel(params) {
    const profile = resolveThinkingProfile({
        provider: params.provider,
        model: params.model,
        catalog: params.catalog,
    });
    if (profile.defaultLevel) {
        return profile.defaultLevel;
    }
    const fallback = resolveThinkingDefaultForModelFallback(params);
    if (fallback === "off") {
        return "off";
    }
    return resolveSupportedThinkingLevelFromProfile(profile, "medium");
}
export function resolveLargestSupportedThinkingLevel(provider, model) {
    const profile = resolveThinkingProfile({ provider, model });
    return (profile.levels.filter((level) => level.id !== "off").toSorted((a, b) => b.rank - a.rank)[0]
        ?.id ?? "off");
}
export function isThinkingLevelSupported(params) {
    return supportsThinkingLevel(params.provider, params.model, params.level);
}
function resolveSupportedThinkingLevelFromProfile(profile, level) {
    if (profile.levels.some((entry) => entry.id === level)) {
        return level;
    }
    const requestedRank = THINKING_LEVEL_RANKS[level];
    const ranked = profile.levels.toSorted((a, b) => b.rank - a.rank);
    return (ranked.find((entry) => entry.id !== "off" && entry.rank <= requestedRank)?.id ??
        ranked.find((entry) => entry.id !== "off")?.id ??
        "off");
}
export function resolveSupportedThinkingLevel(params) {
    const profile = resolveThinkingProfile({ provider: params.provider, model: params.model });
    return resolveSupportedThinkingLevelFromProfile(profile, params.level);
}
