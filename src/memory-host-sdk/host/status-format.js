export function resolveMemoryVectorState(vector) {
    if (!vector.enabled) {
        return { tone: "muted", state: "disabled" };
    }
    if (vector.available === true) {
        return { tone: "ok", state: "ready" };
    }
    if (vector.available === false) {
        return { tone: "warn", state: "unavailable" };
    }
    return { tone: "muted", state: "unknown" };
}
export function resolveMemoryFtsState(fts) {
    if (!fts.enabled) {
        return { tone: "muted", state: "disabled" };
    }
    return fts.available ? { tone: "ok", state: "ready" } : { tone: "warn", state: "unavailable" };
}
export function resolveMemoryCacheSummary(cache) {
    if (!cache.enabled) {
        return { tone: "muted", text: "cache off" };
    }
    const suffix = typeof cache.entries === "number" ? ` (${cache.entries})` : "";
    return { tone: "ok", text: `cache on${suffix}` };
}
export function resolveMemoryCacheState(cache) {
    return cache.enabled ? { tone: "ok", state: "enabled" } : { tone: "muted", state: "disabled" };
}
