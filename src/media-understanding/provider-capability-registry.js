import { resolvePluginCapabilityProviders } from "../plugins/capability-provider-runtime.js";
import { resolveImageCapableConfigProviderIds } from "./config-provider-models.js";
import { normalizeMediaProviderId } from "./provider-id.js";
function mergeProviderCapabilities(registry, provider) {
    const normalizedKey = normalizeMediaProviderId(provider.id);
    const existing = registry.get(normalizedKey);
    registry.set(normalizedKey, {
        capabilities: provider.capabilities ?? existing?.capabilities,
    });
}
export function buildMediaUnderstandingCapabilityRegistry(cfg) {
    const registry = new Map();
    for (const provider of resolvePluginCapabilityProviders({
        key: "mediaUnderstandingProviders",
        cfg,
    })) {
        mergeProviderCapabilities(registry, provider);
    }
    for (const normalizedKey of resolveImageCapableConfigProviderIds(cfg)) {
        if (!registry.has(normalizedKey)) {
            mergeProviderCapabilities(registry, {
                id: normalizedKey,
                capabilities: ["image"],
            });
        }
    }
    return registry;
}
