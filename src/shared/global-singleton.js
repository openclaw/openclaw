// Safe for process-local caches and registries that can tolerate helper-based
// resolution. Do not use this for live mutable state that must survive split
// runtime chunks; keep those on a direct globalThis[Symbol.for(...)] lookup.
export function resolveGlobalSingleton(key, create) {
    const globalStore = globalThis;
    if (Object.prototype.hasOwnProperty.call(globalStore, key)) {
        return globalStore[key];
    }
    const created = create();
    globalStore[key] = created;
    return created;
}
export function resolveGlobalMap(key) {
    return resolveGlobalSingleton(key, () => new Map());
}
