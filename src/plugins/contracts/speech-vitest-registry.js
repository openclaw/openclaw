import { loadBundledCapabilityRuntimeRegistry } from "../bundled-capability-runtime.js";
import { BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS } from "./inventory/bundled-capability-metadata.js";
const VITEST_CONTRACT_PLUGIN_IDS = {
    imageGenerationProviders: BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS.filter((entry) => entry.imageGenerationProviderIds.length > 0).map((entry) => entry.pluginId),
    speechProviders: BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS.filter((entry) => entry.speechProviderIds.length > 0).map((entry) => entry.pluginId),
    mediaUnderstandingProviders: BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS.filter((entry) => entry.mediaUnderstandingProviderIds.length > 0).map((entry) => entry.pluginId),
    realtimeVoiceProviders: BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS.filter((entry) => entry.realtimeVoiceProviderIds.length > 0).map((entry) => entry.pluginId),
    realtimeTranscriptionProviders: BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS.filter((entry) => entry.realtimeTranscriptionProviderIds.length > 0).map((entry) => entry.pluginId),
    videoGenerationProviders: BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS.filter((entry) => entry.videoGenerationProviderIds.length > 0).map((entry) => entry.pluginId),
    musicGenerationProviders: BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS.filter((entry) => entry.musicGenerationProviderIds.length > 0).map((entry) => entry.pluginId),
};
function loadVitestVideoGenerationFallbackEntries(pluginIds) {
    return loadVitestCapabilityContractEntries({
        contract: "videoGenerationProviders",
        pluginSdkResolution: "src",
        pluginIds,
        pickEntries: (registry) => registry.videoGenerationProviders.map((entry) => ({
            pluginId: entry.pluginId,
            provider: entry.provider,
        })),
    });
}
function loadVitestMusicGenerationFallbackEntries(pluginIds) {
    return loadVitestCapabilityContractEntries({
        contract: "musicGenerationProviders",
        pluginSdkResolution: "src",
        pluginIds,
        pickEntries: (registry) => registry.musicGenerationProviders.map((entry) => ({
            pluginId: entry.pluginId,
            provider: entry.provider,
        })),
    });
}
function loadVitestSpeechFallbackEntries(pluginIds) {
    return loadVitestCapabilityContractEntries({
        contract: "speechProviders",
        pluginSdkResolution: "src",
        pluginIds,
        pickEntries: (registry) => registry.speechProviders.map((entry) => ({
            pluginId: entry.pluginId,
            provider: entry.provider,
        })),
    });
}
function hasExplicitVideoGenerationModes(provider) {
    return Boolean(provider.capabilities.generate &&
        provider.capabilities.imageToVideo &&
        provider.capabilities.videoToVideo);
}
function hasExplicitMusicGenerationModes(provider) {
    return Boolean(provider.capabilities.generate && provider.capabilities.edit);
}
function loadVitestCapabilityContractEntries(params) {
    const pluginIds = [...(params.pluginIds ?? VITEST_CONTRACT_PLUGIN_IDS[params.contract])];
    if (pluginIds.length === 0) {
        return [];
    }
    const bulkEntries = params.pickEntries(loadBundledCapabilityRuntimeRegistry({
        pluginIds,
        pluginSdkResolution: params.pluginSdkResolution ?? "dist",
    }));
    const coveredPluginIds = new Set(bulkEntries.map((entry) => entry.pluginId));
    if (coveredPluginIds.size === pluginIds.length) {
        return bulkEntries;
    }
    return pluginIds.flatMap((pluginId) => params
        .pickEntries(loadBundledCapabilityRuntimeRegistry({
        pluginIds: [pluginId],
        pluginSdkResolution: params.pluginSdkResolution ?? "dist",
    }))
        .filter((entry) => entry.pluginId === pluginId));
}
export function loadVitestSpeechProviderContractRegistry() {
    const entries = loadVitestCapabilityContractEntries({
        contract: "speechProviders",
        pickEntries: (registry) => registry.speechProviders.map((entry) => ({
            pluginId: entry.pluginId,
            provider: entry.provider,
        })),
    });
    const coveredPluginIds = new Set(entries.map((entry) => entry.pluginId));
    const missingPluginIds = VITEST_CONTRACT_PLUGIN_IDS.speechProviders.filter((pluginId) => !coveredPluginIds.has(pluginId));
    if (missingPluginIds.length === 0) {
        return entries;
    }
    const replacementEntries = loadVitestSpeechFallbackEntries(missingPluginIds);
    const replacedPluginIds = new Set(replacementEntries.map((entry) => entry.pluginId));
    return [
        ...entries.filter((entry) => !replacedPluginIds.has(entry.pluginId)),
        ...replacementEntries,
    ];
}
export function loadVitestMediaUnderstandingProviderContractRegistry() {
    return loadVitestCapabilityContractEntries({
        contract: "mediaUnderstandingProviders",
        pickEntries: (registry) => registry.mediaUnderstandingProviders.map((entry) => ({
            pluginId: entry.pluginId,
            provider: entry.provider,
        })),
    });
}
export function loadVitestRealtimeVoiceProviderContractRegistry() {
    return loadVitestCapabilityContractEntries({
        contract: "realtimeVoiceProviders",
        pickEntries: (registry) => registry.realtimeVoiceProviders.map((entry) => ({
            pluginId: entry.pluginId,
            provider: entry.provider,
        })),
    });
}
export function loadVitestRealtimeTranscriptionProviderContractRegistry() {
    return loadVitestCapabilityContractEntries({
        contract: "realtimeTranscriptionProviders",
        pickEntries: (registry) => registry.realtimeTranscriptionProviders.map((entry) => ({
            pluginId: entry.pluginId,
            provider: entry.provider,
        })),
    });
}
export function loadVitestImageGenerationProviderContractRegistry() {
    return loadVitestCapabilityContractEntries({
        contract: "imageGenerationProviders",
        pickEntries: (registry) => registry.imageGenerationProviders.map((entry) => ({
            pluginId: entry.pluginId,
            provider: entry.provider,
        })),
    });
}
export function loadVitestVideoGenerationProviderContractRegistry() {
    const entries = loadVitestCapabilityContractEntries({
        contract: "videoGenerationProviders",
        pickEntries: (registry) => registry.videoGenerationProviders.map((entry) => ({
            pluginId: entry.pluginId,
            provider: entry.provider,
        })),
    });
    const coveredPluginIds = new Set(entries.map((entry) => entry.pluginId));
    const stalePluginIds = new Set(entries
        .filter((entry) => !hasExplicitVideoGenerationModes(entry.provider))
        .map((entry) => entry.pluginId));
    const missingPluginIds = VITEST_CONTRACT_PLUGIN_IDS.videoGenerationProviders.filter((pluginId) => !coveredPluginIds.has(pluginId) || stalePluginIds.has(pluginId));
    if (missingPluginIds.length === 0) {
        return entries;
    }
    const replacementEntries = loadVitestVideoGenerationFallbackEntries(missingPluginIds);
    const replacedPluginIds = new Set(replacementEntries.map((entry) => entry.pluginId));
    return [
        ...entries.filter((entry) => !replacedPluginIds.has(entry.pluginId)),
        ...replacementEntries,
    ];
}
export function loadVitestMusicGenerationProviderContractRegistry() {
    const entries = loadVitestCapabilityContractEntries({
        contract: "musicGenerationProviders",
        pickEntries: (registry) => registry.musicGenerationProviders.map((entry) => ({
            pluginId: entry.pluginId,
            provider: entry.provider,
        })),
    });
    const coveredPluginIds = new Set(entries.map((entry) => entry.pluginId));
    const stalePluginIds = new Set(entries
        .filter((entry) => !hasExplicitMusicGenerationModes(entry.provider))
        .map((entry) => entry.pluginId));
    const missingPluginIds = VITEST_CONTRACT_PLUGIN_IDS.musicGenerationProviders.filter((pluginId) => !coveredPluginIds.has(pluginId) || stalePluginIds.has(pluginId));
    if (missingPluginIds.length === 0) {
        return entries;
    }
    const replacementEntries = loadVitestMusicGenerationFallbackEntries(missingPluginIds);
    const replacedPluginIds = new Set(replacementEntries.map((entry) => entry.pluginId));
    return [
        ...entries.filter((entry) => !replacedPluginIds.has(entry.pluginId)),
        ...replacementEntries,
    ];
}
