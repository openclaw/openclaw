import { normalizeProviderId } from "../agents/model-selection.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { resolvePluginCapabilityProviders } from "../plugins/capability-provider-runtime.js";
const BUILTIN_IMAGE_GENERATION_PROVIDERS = [];
const UNSAFE_PROVIDER_IDS = new Set(["__proto__", "constructor", "prototype"]);
function normalizeImageGenerationProviderId(id) {
    const normalized = normalizeProviderId(id ?? "");
    if (!normalized || isBlockedObjectKey(normalized)) {
        return undefined;
    }
    return normalized;
}
function isSafeImageGenerationProviderId(id) {
    return Boolean(id && !UNSAFE_PROVIDER_IDS.has(id));
}
function resolvePluginImageGenerationProviders(cfg) {
    return resolvePluginCapabilityProviders({
        key: "imageGenerationProviders",
        cfg,
    });
}
function buildProviderMaps(cfg) {
    const canonical = new Map();
    const aliases = new Map();
    const register = (provider) => {
        const id = normalizeImageGenerationProviderId(provider.id);
        if (!isSafeImageGenerationProviderId(id)) {
            return;
        }
        canonical.set(id, provider);
        aliases.set(id, provider);
        for (const alias of provider.aliases ?? []) {
            const normalizedAlias = normalizeImageGenerationProviderId(alias);
            if (isSafeImageGenerationProviderId(normalizedAlias)) {
                aliases.set(normalizedAlias, provider);
            }
        }
    };
    for (const provider of BUILTIN_IMAGE_GENERATION_PROVIDERS) {
        register(provider);
    }
    for (const provider of resolvePluginImageGenerationProviders(cfg)) {
        register(provider);
    }
    return { canonical, aliases };
}
export function listImageGenerationProviders(cfg) {
    return [...buildProviderMaps(cfg).canonical.values()];
}
export function getImageGenerationProvider(providerId, cfg) {
    const normalized = normalizeImageGenerationProviderId(providerId);
    if (!normalized) {
        return undefined;
    }
    return buildProviderMaps(cfg).aliases.get(normalized);
}
