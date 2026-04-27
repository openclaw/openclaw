import { resolveBundledWebSearchProvidersFromPublicArtifacts } from "./web-provider-public-artifacts.js";
import { mapRegistryProviders, resolveManifestDeclaredWebProviderCandidatePluginIds, } from "./web-provider-resolution-shared.js";
import { createWebProviderSnapshotCache, resolvePluginWebProviders, resolveRuntimeWebProviders, } from "./web-provider-runtime-shared.js";
import { resolveBundledWebSearchResolutionConfig, sortWebSearchProviders, } from "./web-search-providers.shared.js";
let webSearchProviderSnapshotCache = createWebProviderSnapshotCache();
function resetWebSearchProviderSnapshotCacheForTests() {
    webSearchProviderSnapshotCache = createWebProviderSnapshotCache();
}
export const __testing = {
    resetWebSearchProviderSnapshotCacheForTests,
};
function resolveWebSearchCandidatePluginIds(params) {
    return resolveManifestDeclaredWebProviderCandidatePluginIds({
        contract: "webSearchProviders",
        configKey: "webSearch",
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
        onlyPluginIds: params.onlyPluginIds,
        origin: params.origin,
    });
}
function mapRegistryWebSearchProviders(params) {
    return mapRegistryProviders({
        entries: params.registry.webSearchProviders,
        onlyPluginIds: params.onlyPluginIds,
        sortProviders: sortWebSearchProviders,
    });
}
export function resolvePluginWebSearchProviders(params) {
    return resolvePluginWebProviders(params, {
        snapshotCache: webSearchProviderSnapshotCache,
        resolveBundledResolutionConfig: resolveBundledWebSearchResolutionConfig,
        resolveCandidatePluginIds: resolveWebSearchCandidatePluginIds,
        mapRegistryProviders: mapRegistryWebSearchProviders,
        resolveBundledPublicArtifactProviders: resolveBundledWebSearchProvidersFromPublicArtifacts,
    });
}
export function resolveRuntimeWebSearchProviders(params) {
    return resolveRuntimeWebProviders(params, {
        snapshotCache: webSearchProviderSnapshotCache,
        resolveBundledResolutionConfig: resolveBundledWebSearchResolutionConfig,
        resolveCandidatePluginIds: resolveWebSearchCandidatePluginIds,
        mapRegistryProviders: mapRegistryWebSearchProviders,
    });
}
