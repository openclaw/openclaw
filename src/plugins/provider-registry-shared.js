import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
export function normalizeCapabilityProviderId(providerId) {
    return normalizeOptionalLowercaseString(providerId);
}
export function buildCapabilityProviderMaps(providers, normalizeId = normalizeCapabilityProviderId) {
    const canonical = new Map();
    const aliases = new Map();
    for (const provider of providers) {
        const id = normalizeId(provider.id);
        if (!id) {
            continue;
        }
        canonical.set(id, provider);
        aliases.set(id, provider);
        for (const alias of provider.aliases ?? []) {
            const normalizedAlias = normalizeId(alias);
            if (normalizedAlias) {
                aliases.set(normalizedAlias, provider);
            }
        }
    }
    return { canonical, aliases };
}
