import { normalizeProviderId } from "../agents/model-selection.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { resolvePluginCapabilityProviders } from "../plugins/capability-provider-runtime.js";
const BUILTIN_MUSIC_GENERATION_PROVIDERS = [];
const UNSAFE_PROVIDER_IDS = new Set(["__proto__", "constructor", "prototype"]);
function normalizeMusicGenerationProviderId(id) {
    const normalized = normalizeProviderId(id ?? "");
    if (!normalized || isBlockedObjectKey(normalized)) {
        return undefined;
    }
    return normalized;
}
function isSafeMusicGenerationProviderId(id) {
    return Boolean(id && !UNSAFE_PROVIDER_IDS.has(id));
}
function resolvePluginMusicGenerationProviders(cfg) {
    return resolvePluginCapabilityProviders({
        key: "musicGenerationProviders",
        cfg,
    });
}
function buildProviderMaps(cfg) {
    const canonical = new Map();
    const aliases = new Map();
    const register = (provider) => {
        const id = normalizeMusicGenerationProviderId(provider.id);
        if (!isSafeMusicGenerationProviderId(id)) {
            return;
        }
        canonical.set(id, provider);
        aliases.set(id, provider);
        for (const alias of provider.aliases ?? []) {
            const normalizedAlias = normalizeMusicGenerationProviderId(alias);
            if (isSafeMusicGenerationProviderId(normalizedAlias)) {
                aliases.set(normalizedAlias, provider);
            }
        }
    };
    for (const provider of BUILTIN_MUSIC_GENERATION_PROVIDERS) {
        register(provider);
    }
    for (const provider of resolvePluginMusicGenerationProviders(cfg)) {
        register(provider);
    }
    return { canonical, aliases };
}
export function listMusicGenerationProviders(cfg) {
    return [...buildProviderMaps(cfg).canonical.values()];
}
export function getMusicGenerationProvider(providerId, cfg) {
    const normalized = normalizeMusicGenerationProviderId(providerId);
    if (!normalized) {
        return undefined;
    }
    return buildProviderMaps(cfg).aliases.get(normalized);
}
