import { loadBundledCapabilityRuntimeRegistry } from "../bundled-capability-runtime.js";
import { resolveManifestContractPluginIds } from "../manifest-registry.js";
import type {
  ImageGenerationProviderPlugin,
  MediaUnderstandingProviderPlugin,
  RealtimeTranscriptionProviderPlugin,
  RealtimeVoiceProviderPlugin,
  SpeechProviderPlugin,
  VideoGenerationProviderPlugin,
} from "../types.js";

export type SpeechProviderContractEntry = {
  pluginId: string;
  provider: SpeechProviderPlugin;
};

export type MediaUnderstandingProviderContractEntry = {
  pluginId: string;
  provider: MediaUnderstandingProviderPlugin;
};

export type RealtimeVoiceProviderContractEntry = {
  pluginId: string;
  provider: RealtimeVoiceProviderPlugin;
};

export type RealtimeTranscriptionProviderContractEntry = {
  pluginId: string;
  provider: RealtimeTranscriptionProviderPlugin;
};

export type ImageGenerationProviderContractEntry = {
  pluginId: string;
  provider: ImageGenerationProviderPlugin;
};

export type VideoGenerationProviderContractEntry = {
  pluginId: string;
  provider: VideoGenerationProviderPlugin;
};

type ManifestContractKey =
  | "speechProviders"
  | "mediaUnderstandingProviders"
  | "realtimeVoiceProviders"
  | "realtimeTranscriptionProviders"
  | "imageGenerationProviders"
  | "videoGenerationProviders";

function loadVitestCapabilityContractEntries<T>(params: {
  contract: ManifestContractKey;
  pickEntries: (registry: ReturnType<typeof loadBundledCapabilityRuntimeRegistry>) => Array<{
    pluginId: string;
    provider: T;
  }>;
}): Array<{ pluginId: string; provider: T }> {
  const pluginIds = resolveManifestContractPluginIds({
    contract: params.contract,
    origin: "bundled",
  });
  if (pluginIds.length === 0) {
    return [];
  }
  return params.pickEntries(
    loadBundledCapabilityRuntimeRegistry({
      pluginIds,
      pluginSdkResolution: "dist",
    }),
  );
}

export function loadVitestSpeechProviderContractRegistry(): SpeechProviderContractEntry[] {
  return loadVitestCapabilityContractEntries({
    contract: "speechProviders",
    pickEntries: (registry) =>
      registry.speechProviders.map((entry) => ({
        pluginId: entry.pluginId,
        provider: entry.provider,
      })),
  });
}

export function loadVitestMediaUnderstandingProviderContractRegistry(): MediaUnderstandingProviderContractEntry[] {
  return loadVitestCapabilityContractEntries({
    contract: "mediaUnderstandingProviders",
    pickEntries: (registry) =>
      registry.mediaUnderstandingProviders.map((entry) => ({
        pluginId: entry.pluginId,
        provider: entry.provider,
      })),
  });
}

export function loadVitestRealtimeVoiceProviderContractRegistry(): RealtimeVoiceProviderContractEntry[] {
  return loadVitestCapabilityContractEntries({
    contract: "realtimeVoiceProviders",
    pickEntries: (registry) =>
      registry.realtimeVoiceProviders.map((entry) => ({
        pluginId: entry.pluginId,
        provider: entry.provider,
      })),
  });
}

export function loadVitestRealtimeTranscriptionProviderContractRegistry(): RealtimeTranscriptionProviderContractEntry[] {
  return loadVitestCapabilityContractEntries({
    contract: "realtimeTranscriptionProviders",
    pickEntries: (registry) =>
      registry.realtimeTranscriptionProviders.map((entry) => ({
        pluginId: entry.pluginId,
        provider: entry.provider,
      })),
  });
}

export function loadVitestImageGenerationProviderContractRegistry(): ImageGenerationProviderContractEntry[] {
  return loadVitestCapabilityContractEntries({
    contract: "imageGenerationProviders",
    pickEntries: (registry) =>
      registry.imageGenerationProviders.map((entry) => ({
        pluginId: entry.pluginId,
        provider: entry.provider,
      })),
  });
}

export function loadVitestVideoGenerationProviderContractRegistry(): VideoGenerationProviderContractEntry[] {
  return loadVitestCapabilityContractEntries({
    contract: "videoGenerationProviders",
    pickEntries: (registry) =>
      registry.videoGenerationProviders.map((entry) => ({
        pluginId: entry.pluginId,
        provider: entry.provider,
      })),
  });
}
