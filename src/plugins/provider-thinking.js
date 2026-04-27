import { normalizeProviderId } from "../agents/provider-id.js";
const PLUGIN_REGISTRY_STATE = Symbol.for("openclaw.pluginRegistryState");
function matchesProviderId(provider, providerId) {
    const normalized = normalizeProviderId(providerId);
    if (!normalized) {
        return false;
    }
    if (normalizeProviderId(provider.id) === normalized) {
        return true;
    }
    return (provider.aliases ?? []).some((alias) => normalizeProviderId(alias) === normalized);
}
function resolveActiveThinkingProvider(providerId) {
    const state = globalThis[PLUGIN_REGISTRY_STATE];
    const activeProvider = state?.activeRegistry?.providers?.find((entry) => {
        return matchesProviderId(entry.provider, providerId);
    })?.provider;
    if (activeProvider) {
        return activeProvider;
    }
    return undefined;
}
export function resolveProviderBinaryThinking(params) {
    return resolveActiveThinkingProvider(params.provider)?.isBinaryThinking?.(params.context);
}
export function resolveProviderXHighThinking(params) {
    return resolveActiveThinkingProvider(params.provider)?.supportsXHighThinking?.(params.context);
}
export function resolveProviderThinkingProfile(params) {
    return resolveActiveThinkingProvider(params.provider)?.resolveThinkingProfile?.(params.context);
}
export function resolveProviderDefaultThinkingLevel(params) {
    return resolveActiveThinkingProvider(params.provider)?.resolveDefaultThinkingLevel?.(params.context);
}
