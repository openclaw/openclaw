import { normalizeMediaProviderId } from "./provider-id.js";
function hasImageCapableModel(providerCfg) {
    const models = providerCfg.models ?? [];
    return models.some((model) => Array.isArray(model?.input) && model.input.includes("image"));
}
export function resolveImageCapableConfigProviderIds(cfg) {
    const configProviders = cfg?.models?.providers;
    if (!configProviders || typeof configProviders !== "object") {
        return [];
    }
    const providerIds = [];
    for (const [providerKey, providerCfg] of Object.entries(configProviders)) {
        if (!providerKey?.trim() || !hasImageCapableModel(providerCfg)) {
            continue;
        }
        providerIds.push(normalizeMediaProviderId(providerKey));
    }
    return providerIds;
}
