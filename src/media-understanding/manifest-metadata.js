import { loadPluginManifestRegistry } from "../plugins/manifest-registry.js";
import { normalizeMediaProviderId } from "./provider-id.js";
export function buildMediaUnderstandingManifestMetadataRegistry(cfg) {
    const registry = new Map();
    for (const plugin of loadPluginManifestRegistry({
        config: cfg,
        env: process.env,
    }).plugins) {
        const declaredProviders = new Set((plugin.contracts?.mediaUnderstandingProviders ?? []).map((providerId) => normalizeMediaProviderId(providerId)));
        for (const [providerId, metadata] of Object.entries(plugin.mediaUnderstandingProviderMetadata ?? {})) {
            const normalizedProviderId = normalizeMediaProviderId(providerId);
            if (!normalizedProviderId || !declaredProviders.has(normalizedProviderId)) {
                continue;
            }
            registry.set(normalizedProviderId, {
                id: normalizedProviderId,
                capabilities: metadata.capabilities,
                defaultModels: metadata.defaultModels,
                autoPriority: metadata.autoPriority,
                nativeDocumentInputs: metadata.nativeDocumentInputs,
            });
        }
    }
    return registry;
}
