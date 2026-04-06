import { createJiti } from "jiti";
import { loadBundledCapabilityRuntimeRegistry } from "../bundled-capability-runtime.js";
import { resolveBundledPluginRepoEntryPath } from "../bundled-plugin-metadata.js";
import { createCapturedPluginRegistration } from "../captured-registration.js";
import type { OpenClawPluginDefinition } from "../types.js";
import type {
  ImageGenerationProviderPlugin,
  MediaUnderstandingProviderPlugin,
  MusicGenerationProviderPlugin,
  RealtimeTranscriptionProviderPlugin,
  RealtimeVoiceProviderPlugin,
  SpeechProviderPlugin,
  VideoGenerationProviderPlugin,
} from "../types.js";
import { BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS } from "./inventory/bundled-capability-metadata.js";

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

export type MusicGenerationProviderContractEntry = {
  pluginId: string;
  provider: MusicGenerationProviderPlugin;
};

type ManifestContractKey =
  | "imageGenerationProviders"
  | "speechProviders"
  | "mediaUnderstandingProviders"
  | "realtimeVoiceProviders"
  | "realtimeTranscriptionProviders"
  | "videoGenerationProviders"
  | "musicGenerationProviders";

const VITEST_CONTRACT_PLUGIN_IDS = {
  imageGenerationProviders: BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS.filter(
    (entry) => entry.imageGenerationProviderIds.length > 0,
  ).map((entry) => entry.pluginId),
  speechProviders: BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS.filter(
    (entry) => entry.speechProviderIds.length > 0,
  ).map((entry) => entry.pluginId),
  mediaUnderstandingProviders: BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS.filter(
    (entry) => entry.mediaUnderstandingProviderIds.length > 0,
  ).map((entry) => entry.pluginId),
  realtimeVoiceProviders: BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS.filter(
    (entry) => entry.realtimeVoiceProviderIds.length > 0,
  ).map((entry) => entry.pluginId),
  realtimeTranscriptionProviders: BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS.filter(
    (entry) => entry.realtimeTranscriptionProviderIds.length > 0,
  ).map((entry) => entry.pluginId),
  videoGenerationProviders: BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS.filter(
    (entry) => entry.videoGenerationProviderIds.length > 0,
  ).map((entry) => entry.pluginId),
} satisfies Record<ManifestContractKey, string[]>;

function loadVitestVideoGenerationFallbackEntries(
  pluginIds: readonly string[],
): VideoGenerationProviderContractEntry[] {
  const jiti = createJiti(import.meta.url, {
    interopDefault: true,
    moduleCache: false,
    fsCache: false,
  });
  const repoRoot = process.cwd();
  return pluginIds.flatMap((pluginId) => {
    const modulePath = resolveBundledPluginRepoEntryPath({
      rootDir: repoRoot,
      pluginId,
      preferBuilt: true,
    });
    if (!modulePath) {
      return [];
    }
    try {
      const mod = jiti(modulePath) as
        | OpenClawPluginDefinition
        | { default?: OpenClawPluginDefinition };
      const plugin =
        (mod as { default?: OpenClawPluginDefinition }).default ??
        (mod as OpenClawPluginDefinition);
      if (typeof plugin?.register !== "function") {
        return [];
      }
      const captured = createCapturedPluginRegistration();
      void plugin.register(captured.api);
      return captured.videoGenerationProviders.map((provider) => ({
        pluginId,
        provider,
      }));
    } catch {
      return [];
    }
  });
}

function loadVitestCapabilityContractEntries<T>(params: {
  contract: ManifestContractKey;
  pickEntries: (registry: ReturnType<typeof loadBundledCapabilityRuntimeRegistry>) => Array<{
    pluginId: string;
    provider: T;
  }>;
}): Array<{ pluginId: string; provider: T }> {
  const pluginIds = VITEST_CONTRACT_PLUGIN_IDS[params.contract];
  if (pluginIds.length === 0) {
    return [];
  }
  const bulkEntries = params.pickEntries(
    loadBundledCapabilityRuntimeRegistry({
      pluginIds,
      pluginSdkResolution: "dist",
    }),
  );
  const coveredPluginIds = new Set(bulkEntries.map((entry) => entry.pluginId));
  if (coveredPluginIds.size === pluginIds.length) {
    return bulkEntries;
  }
  return pluginIds.flatMap((pluginId) =>
    params
      .pickEntries(
        loadBundledCapabilityRuntimeRegistry({
          pluginIds: [pluginId],
          pluginSdkResolution: "dist",
        }),
      )
      .filter((entry) => entry.pluginId === pluginId),
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
  const entries = loadVitestCapabilityContractEntries({
    contract: "videoGenerationProviders",
    pickEntries: (registry) =>
      registry.videoGenerationProviders.map((entry) => ({
        pluginId: entry.pluginId,
        provider: entry.provider,
      })),
  });
  const coveredPluginIds = new Set(entries.map((entry) => entry.pluginId));
  const missingPluginIds = VITEST_CONTRACT_PLUGIN_IDS.videoGenerationProviders.filter(
    (pluginId) => !coveredPluginIds.has(pluginId),
  );
  if (missingPluginIds.length === 0) {
    return entries;
  }
  return [...entries, ...loadVitestVideoGenerationFallbackEntries(missingPluginIds)];
}

export function loadVitestMusicGenerationProviderContractRegistry(): MusicGenerationProviderContractEntry[] {
  return loadVitestCapabilityContractEntries({
    contract: "musicGenerationProviders",
    pickEntries: (registry) =>
      registry.musicGenerationProviders.map((entry) => ({
        pluginId: entry.pluginId,
        provider: entry.provider,
      })),
  });
}
