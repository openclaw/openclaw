import { createEffectiveEnableStateResolver, createPluginEnableStateResolver, resolveMemorySlotDecisionShared, resolvePluginActivationDecisionShared, toPluginActivationState, } from "./config-activation-shared.js";
import { hasExplicitPluginConfig as hasExplicitPluginConfigShared, identityNormalizePluginId, isBundledChannelEnabledByChannelConfig as isBundledChannelEnabledByChannelConfigShared, normalizePluginsConfigWithResolver as normalizePluginsConfigWithResolverShared, } from "./config-normalization-shared.js";
export function normalizePluginsConfigWithResolver(config, normalizePluginId = identityNormalizePluginId) {
    return normalizePluginsConfigWithResolverShared(config, normalizePluginId);
}
export function resolvePluginActivationState(params) {
    return toPluginActivationState(resolvePluginActivationDecisionShared({
        ...params,
        activationSource: {
            plugins: params.sourceConfig ?? params.config,
            rootConfig: params.sourceRootConfig ?? params.rootConfig,
        },
        isBundledChannelEnabledByChannelConfig,
    }));
}
export const hasExplicitPluginConfig = hasExplicitPluginConfigShared;
export const resolveEnableState = createPluginEnableStateResolver(resolvePluginActivationState);
export const isBundledChannelEnabledByChannelConfig = isBundledChannelEnabledByChannelConfigShared;
export const resolveEffectiveEnableState = createEffectiveEnableStateResolver(resolveEffectivePluginActivationState);
export function resolveEffectivePluginActivationState(params) {
    return resolvePluginActivationState(params);
}
export function resolveMemorySlotDecision(params) {
    return resolveMemorySlotDecisionShared(params);
}
