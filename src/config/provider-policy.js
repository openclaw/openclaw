import { resolveBundledProviderPolicySurface } from "../plugins/provider-public-artifacts.js";
export function normalizeProviderConfigForConfigDefaults(params) {
    const normalized = resolveBundledProviderPolicySurface(params.provider)?.normalizeConfig?.({
        provider: params.provider,
        providerConfig: params.providerConfig,
    });
    return normalized && normalized !== params.providerConfig ? normalized : params.providerConfig;
}
export function applyProviderConfigDefaultsForConfig(params) {
    return (resolveBundledProviderPolicySurface(params.provider)?.applyConfigDefaults?.({
        provider: params.provider,
        config: params.config,
        env: params.env,
    }) ?? params.config);
}
