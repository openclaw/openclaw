import { resolveBundledWebProviderResolutionConfig, sortPluginProviders, sortPluginProvidersForAutoDetect, } from "./web-provider-resolution-shared.js";
export function sortWebSearchProviders(providers) {
    return sortPluginProviders(providers);
}
export function sortWebSearchProvidersForAutoDetect(providers) {
    return sortPluginProvidersForAutoDetect(providers);
}
export function resolveBundledWebSearchResolutionConfig(params) {
    return resolveBundledWebProviderResolutionConfig({
        contract: "webSearchProviders",
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
        bundledAllowlistCompat: params.bundledAllowlistCompat,
    });
}
