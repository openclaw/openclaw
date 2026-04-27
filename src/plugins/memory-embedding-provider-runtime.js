import { resolvePluginCapabilityProvider, resolvePluginCapabilityProviders, } from "./capability-provider-runtime.js";
import { getRegisteredMemoryEmbeddingProvider, listRegisteredMemoryEmbeddingProviders, } from "./memory-embedding-providers.js";
export { listRegisteredMemoryEmbeddingProviders };
export function listRegisteredMemoryEmbeddingProviderAdapters() {
    return listRegisteredMemoryEmbeddingProviders().map((entry) => entry.adapter);
}
export function listMemoryEmbeddingProviders(cfg) {
    const registered = listRegisteredMemoryEmbeddingProviderAdapters();
    const merged = new Map(registered.map((adapter) => [adapter.id, adapter]));
    for (const adapter of resolvePluginCapabilityProviders({
        key: "memoryEmbeddingProviders",
        cfg,
    })) {
        if (!merged.has(adapter.id)) {
            merged.set(adapter.id, adapter);
        }
    }
    return [...merged.values()];
}
export function getMemoryEmbeddingProvider(id, cfg) {
    const registered = getRegisteredMemoryEmbeddingProvider(id);
    if (registered) {
        return registered.adapter;
    }
    return resolvePluginCapabilityProvider({
        key: "memoryEmbeddingProviders",
        providerId: id,
        cfg,
    });
}
