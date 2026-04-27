import { resolveBundledWebFetchResolutionConfig, sortWebFetchProviders, } from "./web-fetch-providers.shared.js";
import { resolveBundledWebFetchProvidersFromPublicArtifacts } from "./web-provider-public-artifacts.js";
import { mapRegistryProviders, resolveManifestDeclaredWebProviderCandidatePluginIds, } from "./web-provider-resolution-shared.js";
import { createWebProviderSnapshotCache, resolvePluginWebProviders, resolveRuntimeWebProviders, } from "./web-provider-runtime-shared.js";
let webFetchProviderSnapshotCache = createWebProviderSnapshotCache();
function resetWebFetchProviderSnapshotCacheForTests() {
    webFetchProviderSnapshotCache = createWebProviderSnapshotCache();
}
export const __testing = {
    resetWebFetchProviderSnapshotCacheForTests,
};
function resolveWebFetchCandidatePluginIds(params) {
    return resolveManifestDeclaredWebProviderCandidatePluginIds({
        contract: "webFetchProviders",
        configKey: "webFetch",
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
        onlyPluginIds: params.onlyPluginIds,
        origin: params.origin,
    });
}
function mapRegistryWebFetchProviders(params) {
    return mapRegistryProviders({
        entries: params.registry.webFetchProviders,
        onlyPluginIds: params.onlyPluginIds,
        sortProviders: sortWebFetchProviders,
    });
}
export function resolvePluginWebFetchProviders(params) {
    return resolvePluginWebProviders(params, {
        snapshotCache: webFetchProviderSnapshotCache,
        resolveBundledResolutionConfig: resolveBundledWebFetchResolutionConfig,
        resolveCandidatePluginIds: resolveWebFetchCandidatePluginIds,
        mapRegistryProviders: mapRegistryWebFetchProviders,
        resolveBundledPublicArtifactProviders: resolveBundledWebFetchProvidersFromPublicArtifacts,
    });
}
export function resolveRuntimeWebFetchProviders(params) {
    return resolveRuntimeWebProviders(params, {
        snapshotCache: webFetchProviderSnapshotCache,
        resolveBundledResolutionConfig: resolveBundledWebFetchResolutionConfig,
        resolveCandidatePluginIds: resolveWebFetchCandidatePluginIds,
        mapRegistryProviders: mapRegistryWebFetchProviders,
    });
}
