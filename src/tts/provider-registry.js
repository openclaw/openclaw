import { resolvePluginCapabilityProvider, resolvePluginCapabilityProviders, } from "../plugins/capability-provider-runtime.js";
import { buildCapabilityProviderMaps, normalizeCapabilityProviderId, } from "../plugins/provider-registry-shared.js";
export function normalizeSpeechProviderId(providerId) {
    return normalizeCapabilityProviderId(providerId);
}
function resolveSpeechProviderPluginEntries(cfg) {
    return resolvePluginCapabilityProviders({
        key: "speechProviders",
        cfg,
    });
}
function buildProviderMaps(cfg) {
    return buildCapabilityProviderMaps(resolveSpeechProviderPluginEntries(cfg));
}
export function listSpeechProviders(cfg) {
    return [...buildProviderMaps(cfg).canonical.values()];
}
export function getSpeechProvider(providerId, cfg) {
    const normalized = normalizeSpeechProviderId(providerId);
    if (!normalized) {
        return undefined;
    }
    return (resolvePluginCapabilityProvider({
        key: "speechProviders",
        providerId: normalized,
        cfg,
    }) ?? buildProviderMaps(cfg).aliases.get(normalized));
}
export function canonicalizeSpeechProviderId(providerId, cfg) {
    const normalized = normalizeSpeechProviderId(providerId);
    if (!normalized) {
        return undefined;
    }
    return getSpeechProvider(normalized, cfg)?.id ?? normalized;
}
