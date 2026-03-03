export function resolveAgentModelPrimaryValue(model) {
    if (typeof model === "string") {
        const trimmed = model.trim();
        return trimmed || undefined;
    }
    if (!model || typeof model !== "object") {
        return undefined;
    }
    const primary = model.primary?.trim();
    return primary || undefined;
}
export function resolveAgentModelFallbackValues(model) {
    if (!model || typeof model !== "object") {
        return [];
    }
    return Array.isArray(model.fallbacks) ? model.fallbacks : [];
}
export function toAgentModelListLike(model) {
    if (typeof model === "string") {
        const primary = model.trim();
        return primary ? { primary } : undefined;
    }
    if (!model || typeof model !== "object") {
        return undefined;
    }
    return model;
}
