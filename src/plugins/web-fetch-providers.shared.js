import { resolveBundledWebProviderResolutionConfig, sortPluginProviders, sortPluginProvidersForAutoDetect, } from "./web-provider-resolution-shared.js";
export function sortWebFetchProviders(providers) {
    return sortPluginProviders(providers);
}
export function sortWebFetchProvidersForAutoDetect(providers) {
    return sortPluginProvidersForAutoDetect(providers);
}
export function resolveBundledWebFetchResolutionConfig(params) {
    return resolveBundledWebProviderResolutionConfig({
        contract: "webFetchProviders",
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
        bundledAllowlistCompat: params.bundledAllowlistCompat,
    });
}
