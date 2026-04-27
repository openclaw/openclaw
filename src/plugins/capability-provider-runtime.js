import { withBundledPluginAllowlistCompat, withBundledPluginEnablementCompat, withBundledPluginVitestCompat, } from "./bundled-compat.js";
import { hasExplicitPluginConfig } from "./config-policy.js";
import { resolveRuntimePluginRegistry } from "./loader.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
const CAPABILITY_CONTRACT_KEY = {
    memoryEmbeddingProviders: "memoryEmbeddingProviders",
    speechProviders: "speechProviders",
    realtimeTranscriptionProviders: "realtimeTranscriptionProviders",
    realtimeVoiceProviders: "realtimeVoiceProviders",
    mediaUnderstandingProviders: "mediaUnderstandingProviders",
    imageGenerationProviders: "imageGenerationProviders",
    videoGenerationProviders: "videoGenerationProviders",
    musicGenerationProviders: "musicGenerationProviders",
};
function resolveBundledCapabilityCompatPluginIds(params) {
    const contractKey = CAPABILITY_CONTRACT_KEY[params.key];
    return loadPluginManifestRegistry({
        config: params.cfg,
        env: process.env,
    })
        .plugins.filter((plugin) => plugin.origin === "bundled" &&
        (plugin.contracts?.[contractKey]?.length ?? 0) > 0 &&
        (!params.providerId || (plugin.contracts?.[contractKey] ?? []).includes(params.providerId)))
        .map((plugin) => plugin.id)
        .toSorted((left, right) => left.localeCompare(right));
}
function resolveCapabilityProviderConfig(params) {
    const pluginIds = params.pluginIds ?? resolveBundledCapabilityCompatPluginIds(params);
    const allowlistCompat = withBundledPluginAllowlistCompat({
        config: params.cfg,
        pluginIds,
    });
    const enablementCompat = withBundledPluginEnablementCompat({
        config: allowlistCompat,
        pluginIds,
    });
    return withBundledPluginVitestCompat({
        config: enablementCompat,
        pluginIds,
        env: process.env,
    });
}
function findProviderById(entries, providerId) {
    const providerEntries = entries;
    for (const entry of providerEntries) {
        if (entry.provider.id === providerId) {
            return entry.provider;
        }
    }
    return undefined;
}
function mergeCapabilityProviders(left, right) {
    const merged = new Map();
    const unnamed = [];
    const addEntries = (entries) => {
        for (const entry of entries) {
            const provider = entry.provider;
            if (!provider.id) {
                unnamed.push(provider);
                continue;
            }
            if (!merged.has(provider.id)) {
                merged.set(provider.id, provider);
            }
        }
    };
    addEntries(left);
    addEntries(right);
    return [...merged.values(), ...unnamed];
}
function addObjectKeys(target, value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return;
    }
    for (const key of Object.keys(value)) {
        const normalized = key.trim().toLowerCase();
        if (normalized) {
            target.add(normalized);
        }
    }
}
function addStringValue(target, value) {
    if (typeof value !== "string") {
        return;
    }
    const normalized = value.trim().toLowerCase();
    if (normalized) {
        target.add(normalized);
    }
}
function collectRequestedSpeechProviderIds(cfg) {
    const requested = new Set();
    const tts = typeof cfg?.messages?.tts === "object" && cfg.messages.tts !== null
        ? cfg.messages.tts
        : undefined;
    addStringValue(requested, tts?.provider);
    addObjectKeys(requested, tts?.providers);
    addObjectKeys(requested, cfg?.models?.providers);
    return requested;
}
function removeActiveProviderIds(requested, entries) {
    for (const entry of entries) {
        const provider = entry.provider;
        if (typeof provider.id === "string") {
            requested.delete(provider.id.toLowerCase());
        }
        if (Array.isArray(provider.aliases)) {
            for (const alias of provider.aliases) {
                if (typeof alias === "string") {
                    requested.delete(alias.toLowerCase());
                }
            }
        }
    }
}
function filterLoadedProvidersForRequestedConfig(params) {
    if (params.key !== "speechProviders") {
        return [];
    }
    if (params.requested.size === 0) {
        return [];
    }
    return params.entries.filter((entry) => {
        const provider = entry.provider;
        if (typeof provider.id === "string" && params.requested.has(provider.id.toLowerCase())) {
            return true;
        }
        if (Array.isArray(provider.aliases)) {
            return provider.aliases.some((alias) => typeof alias === "string" && params.requested.has(alias.toLowerCase()));
        }
        return false;
    });
}
export function resolvePluginCapabilityProvider(params) {
    const activeRegistry = resolveRuntimePluginRegistry();
    const activeProvider = findProviderById(activeRegistry?.[params.key] ?? [], params.providerId);
    if (activeProvider) {
        return activeProvider;
    }
    const pluginIds = resolveBundledCapabilityCompatPluginIds({
        key: params.key,
        cfg: params.cfg,
        providerId: params.providerId,
    });
    if (pluginIds.length === 0) {
        return undefined;
    }
    const compatConfig = resolveCapabilityProviderConfig({
        key: params.key,
        cfg: params.cfg,
        pluginIds,
    });
    const loadOptions = compatConfig === undefined ? undefined : { config: compatConfig, activate: false };
    const registry = resolveRuntimePluginRegistry(loadOptions);
    return findProviderById(registry?.[params.key] ?? [], params.providerId);
}
export function resolvePluginCapabilityProviders(params) {
    const activeRegistry = resolveRuntimePluginRegistry();
    const activeProviders = activeRegistry?.[params.key] ?? [];
    if (activeProviders.length > 0 &&
        params.key !== "memoryEmbeddingProviders" &&
        params.key !== "speechProviders" &&
        !hasExplicitPluginConfig(params.cfg?.plugins)) {
        return activeProviders.map((entry) => entry.provider);
    }
    if (activeProviders.length > 0 && params.key === "speechProviders" && !params.cfg) {
        return activeProviders.map((entry) => entry.provider);
    }
    const missingRequestedSpeechProviders = activeProviders.length > 0 && params.key === "speechProviders"
        ? collectRequestedSpeechProviderIds(params.cfg)
        : undefined;
    if (missingRequestedSpeechProviders) {
        removeActiveProviderIds(missingRequestedSpeechProviders, activeProviders);
        if (missingRequestedSpeechProviders.size === 0) {
            return activeProviders.map((entry) => entry.provider);
        }
    }
    const compatConfig = resolveCapabilityProviderConfig({ key: params.key, cfg: params.cfg });
    const loadOptions = compatConfig === undefined ? undefined : { config: compatConfig, activate: false };
    const registry = resolveRuntimePluginRegistry(loadOptions);
    const loadedProviders = registry?.[params.key] ?? [];
    if (params.key !== "memoryEmbeddingProviders") {
        const mergeLoadedProviders = activeProviders.length > 0
            ? filterLoadedProvidersForRequestedConfig({
                key: params.key,
                requested: missingRequestedSpeechProviders ?? new Set(),
                entries: loadedProviders,
            })
            : loadedProviders;
        return mergeCapabilityProviders(activeProviders, mergeLoadedProviders);
    }
    return mergeCapabilityProviders(activeProviders, loadedProviders);
}
