import { normalizeProviderId } from "../agents/provider-id.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import { getPluginRegistryState } from "./runtime-state.js";
function uniqueProviderRefs(values) {
    const seen = new Set();
    const next = [];
    for (const raw of values) {
        const trimmed = raw.trim();
        const normalized = normalizeProviderId(trimmed);
        if (!trimmed || seen.has(normalized)) {
            continue;
        }
        seen.add(normalized);
        next.push(trimmed);
    }
    return next;
}
function resolveManifestSyntheticAuthProviderRefs() {
    return uniqueProviderRefs(loadPluginManifestRegistry({ cache: true }).plugins.flatMap((plugin) => plugin.syntheticAuthRefs ?? []));
}
export function resolveRuntimeSyntheticAuthProviderRefs() {
    const registry = getPluginRegistryState()?.activeRegistry;
    if (registry) {
        return uniqueProviderRefs([
            ...(registry.providers ?? [])
                .filter((entry) => "resolveSyntheticAuth" in entry.provider &&
                typeof entry.provider.resolveSyntheticAuth === "function")
                .map((entry) => entry.provider.id),
            ...(registry.cliBackends ?? [])
                .filter((entry) => "resolveSyntheticAuth" in entry.backend &&
                typeof entry.backend.resolveSyntheticAuth === "function")
                .map((entry) => entry.backend.id),
        ]);
    }
    return resolveManifestSyntheticAuthProviderRefs();
}
