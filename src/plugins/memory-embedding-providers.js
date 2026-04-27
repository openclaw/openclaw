const MEMORY_EMBEDDING_PROVIDERS_KEY = Symbol.for("openclaw.memoryEmbeddingProviders");
function getMemoryEmbeddingProviders() {
    const globalStore = globalThis;
    const existing = globalStore[MEMORY_EMBEDDING_PROVIDERS_KEY];
    if (existing instanceof Map) {
        return existing;
    }
    const created = new Map();
    globalStore[MEMORY_EMBEDDING_PROVIDERS_KEY] = created;
    return created;
}
export function registerMemoryEmbeddingProvider(adapter, options) {
    getMemoryEmbeddingProviders().set(adapter.id, {
        adapter,
        ownerPluginId: options?.ownerPluginId,
    });
}
export function getRegisteredMemoryEmbeddingProvider(id) {
    return getMemoryEmbeddingProviders().get(id);
}
export function getMemoryEmbeddingProvider(id) {
    return getMemoryEmbeddingProviders().get(id)?.adapter;
}
export function listRegisteredMemoryEmbeddingProviders() {
    return Array.from(getMemoryEmbeddingProviders().values());
}
export function listMemoryEmbeddingProviders() {
    return listRegisteredMemoryEmbeddingProviders().map((entry) => entry.adapter);
}
export function restoreMemoryEmbeddingProviders(adapters) {
    getMemoryEmbeddingProviders().clear();
    for (const adapter of adapters) {
        registerMemoryEmbeddingProvider(adapter);
    }
}
export function restoreRegisteredMemoryEmbeddingProviders(entries) {
    getMemoryEmbeddingProviders().clear();
    for (const entry of entries) {
        registerMemoryEmbeddingProvider(entry.adapter, {
            ownerPluginId: entry.ownerPluginId,
        });
    }
}
export function clearMemoryEmbeddingProviders() {
    getMemoryEmbeddingProviders().clear();
}
export const _resetMemoryEmbeddingProviders = clearMemoryEmbeddingProviders;
