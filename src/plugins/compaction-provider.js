/**
 * Compaction provider registry — process-global singleton.
 *
 * Plugins implement the CompactionProvider interface and register via
 * `registerCompactionProvider()`. The compaction safeguard checks this
 * registry before falling back to the built-in `summarizeInStages()`.
 */
// ---------------------------------------------------------------------------
// Registry (process-global singleton)
// ---------------------------------------------------------------------------
const COMPACTION_PROVIDER_REGISTRY_STATE = Symbol.for("openclaw.compactionProviderRegistryState");
// Keep compaction-provider registrations process-global so duplicated dist
// chunks still share one registry map at runtime.
function getCompactionProviderRegistryState() {
    const globalState = globalThis;
    if (!globalState[COMPACTION_PROVIDER_REGISTRY_STATE]) {
        globalState[COMPACTION_PROVIDER_REGISTRY_STATE] = {
            providers: new Map(),
        };
    }
    return globalState[COMPACTION_PROVIDER_REGISTRY_STATE];
}
// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------
/**
 * Register a compaction provider implementation.
 * Pass `ownerPluginId` so the loader can snapshot/restore correctly.
 */
export function registerCompactionProvider(provider, options) {
    getCompactionProviderRegistryState().providers.set(provider.id, {
        provider,
        ownerPluginId: options?.ownerPluginId,
    });
}
// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------
/** Return the provider for the given id, or undefined. */
export function getCompactionProvider(id) {
    return getCompactionProviderRegistryState().providers.get(id)?.provider;
}
/** Return the registered entry (provider + owner) for the given id. */
export function getRegisteredCompactionProvider(id) {
    return getCompactionProviderRegistryState().providers.get(id);
}
/** List all registered compaction provider ids. */
export function listCompactionProviderIds() {
    return [...getCompactionProviderRegistryState().providers.keys()];
}
/** List all registered entries with owner metadata (for snapshot/restore). */
export function listRegisteredCompactionProviders() {
    return Array.from(getCompactionProviderRegistryState().providers.values());
}
// ---------------------------------------------------------------------------
// Lifecycle (clear / restore) — mirrors memory-embedding-providers.ts
// ---------------------------------------------------------------------------
/** Clear all compaction providers. Used by clearPluginLoaderCache() and reload. */
export function clearCompactionProviders() {
    getCompactionProviderRegistryState().providers.clear();
}
/** Restore from a snapshot, replacing all current entries. */
export function restoreRegisteredCompactionProviders(entries) {
    const map = getCompactionProviderRegistryState().providers;
    map.clear();
    for (const entry of entries) {
        map.set(entry.provider.id, entry);
    }
}
