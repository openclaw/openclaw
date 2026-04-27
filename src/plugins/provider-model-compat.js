import { detectOpenAICompletionsCompat } from "../agents/openai-completions-compat.js";
export function extractModelCompat(modelOrCompat) {
    if (!modelOrCompat || typeof modelOrCompat !== "object") {
        return undefined;
    }
    if ("compat" in modelOrCompat) {
        const compat = modelOrCompat.compat;
        return compat && typeof compat === "object" ? compat : undefined;
    }
    return modelOrCompat;
}
export function applyModelCompatPatch(model, patch) {
    const nextCompat = { ...model.compat, ...patch };
    if (model.compat &&
        Object.entries(patch).every(([key, value]) => model.compat?.[key] === value)) {
        return model;
    }
    return {
        ...model,
        compat: nextCompat,
    };
}
export function hasToolSchemaProfile(modelOrCompat, profile) {
    return extractModelCompat(modelOrCompat)?.toolSchemaProfile === profile;
}
export function hasNativeWebSearchTool(modelOrCompat) {
    return extractModelCompat(modelOrCompat)?.nativeWebSearchTool === true;
}
export function resolveToolCallArgumentsEncoding(modelOrCompat) {
    return extractModelCompat(modelOrCompat)?.toolCallArgumentsEncoding;
}
export function resolveUnsupportedToolSchemaKeywords(modelOrCompat) {
    const keywords = extractModelCompat(modelOrCompat)?.unsupportedToolSchemaKeywords ?? [];
    return new Set(keywords
        .filter((keyword) => typeof keyword === "string")
        .map((keyword) => keyword.trim())
        .filter(Boolean));
}
function isOpenAiCompletionsModel(model) {
    return model.api === "openai-completions";
}
function isAnthropicMessagesModel(model) {
    return model.api === "anthropic-messages";
}
function normalizeAnthropicBaseUrl(baseUrl) {
    return baseUrl.replace(/\/v1\/?$/, "");
}
export function normalizeModelCompat(model) {
    const baseUrl = model.baseUrl ?? "";
    if (isAnthropicMessagesModel(model) && baseUrl) {
        const normalized = normalizeAnthropicBaseUrl(baseUrl);
        if (normalized !== baseUrl) {
            return { ...model, baseUrl: normalized };
        }
    }
    if (!isOpenAiCompletionsModel(model)) {
        return model;
    }
    const compat = model.compat ?? undefined;
    const detectedCompatDefaults = baseUrl
        ? detectOpenAICompletionsCompat(model).defaults
        : undefined;
    const needsForce = Boolean(detectedCompatDefaults &&
        (!detectedCompatDefaults.supportsDeveloperRole ||
            !detectedCompatDefaults.supportsUsageInStreaming ||
            !detectedCompatDefaults.supportsStrictMode));
    if (!needsForce) {
        return model;
    }
    const forcedDeveloperRole = compat?.supportsDeveloperRole === true;
    const hasStreamingUsageOverride = compat?.supportsUsageInStreaming !== undefined;
    const targetStrictMode = compat?.supportsStrictMode ?? detectedCompatDefaults?.supportsStrictMode;
    if (compat?.supportsDeveloperRole !== undefined &&
        hasStreamingUsageOverride &&
        compat?.supportsStrictMode !== undefined) {
        return model;
    }
    return {
        ...model,
        compat: compat
            ? {
                ...compat,
                supportsDeveloperRole: forcedDeveloperRole || false,
                ...(hasStreamingUsageOverride
                    ? {}
                    : {
                        supportsUsageInStreaming: detectedCompatDefaults?.supportsUsageInStreaming ?? false,
                    }),
                supportsStrictMode: targetStrictMode,
            }
            : {
                supportsDeveloperRole: false,
                supportsUsageInStreaming: detectedCompatDefaults?.supportsUsageInStreaming ?? false,
                supportsStrictMode: detectedCompatDefaults?.supportsStrictMode ?? false,
            },
    };
}
