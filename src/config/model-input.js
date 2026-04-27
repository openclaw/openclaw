import { normalizeOptionalString, resolvePrimaryStringValue } from "../shared/string-coerce.js";
export function resolveAgentModelPrimaryValue(model) {
    return resolvePrimaryStringValue(model);
}
export function resolveAgentModelFallbackValues(model) {
    if (!model || typeof model !== "object") {
        return [];
    }
    return Array.isArray(model.fallbacks) ? model.fallbacks : [];
}
export function resolveAgentModelTimeoutMsValue(model) {
    if (!model || typeof model !== "object") {
        return undefined;
    }
    return typeof model.timeoutMs === "number" &&
        Number.isFinite(model.timeoutMs) &&
        model.timeoutMs > 0
        ? Math.floor(model.timeoutMs)
        : undefined;
}
export function toAgentModelListLike(model) {
    if (typeof model === "string") {
        const primary = normalizeOptionalString(model);
        return primary ? { primary } : undefined;
    }
    if (!model || typeof model !== "object") {
        return undefined;
    }
    return model;
}
