import { normalizeProviderId } from "../agents/model-selection.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { resolvePluginCapabilityProviders } from "../plugins/capability-provider-runtime.js";
const BUILTIN_VIDEO_GENERATION_PROVIDERS = [];
const UNSAFE_PROVIDER_IDS = new Set(["__proto__", "constructor", "prototype"]);
function normalizeVideoGenerationProviderId(id) {
    const normalized = normalizeProviderId(id ?? "");
    if (!normalized || isBlockedObjectKey(normalized)) {
        return undefined;
    }
    return normalized;
}
function isSafeVideoGenerationProviderId(id) {
    return Boolean(id && !UNSAFE_PROVIDER_IDS.has(id));
}
function resolvePluginVideoGenerationProviders(cfg) {
    return resolvePluginCapabilityProviders({
        key: "videoGenerationProviders",
        cfg,
    });
}
function buildProviderMaps(cfg) {
    const canonical = new Map();
    const aliases = new Map();
    const register = (provider) => {
        const id = normalizeVideoGenerationProviderId(provider.id);
        if (!isSafeVideoGenerationProviderId(id)) {
            return;
        }
        canonical.set(id, provider);
        aliases.set(id, provider);
        for (const alias of provider.aliases ?? []) {
            const normalizedAlias = normalizeVideoGenerationProviderId(alias);
            if (isSafeVideoGenerationProviderId(normalizedAlias)) {
                aliases.set(normalizedAlias, provider);
            }
        }
    };
    for (const provider of BUILTIN_VIDEO_GENERATION_PROVIDERS) {
        register(provider);
    }
    for (const provider of resolvePluginVideoGenerationProviders(cfg)) {
        register(provider);
    }
    return { canonical, aliases };
}
export function listVideoGenerationProviders(cfg) {
    return [...buildProviderMaps(cfg).canonical.values()];
}
export function getVideoGenerationProvider(providerId, cfg) {
    const normalized = normalizeVideoGenerationProviderId(providerId);
    if (!normalized) {
        return undefined;
    }
    return buildProviderMaps(cfg).aliases.get(normalized);
}
