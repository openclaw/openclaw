import { listBundledPluginMetadata } from "../../bundled-plugin-metadata.js";
import { uniqueStrings } from "../shared.js";

// Build/test inventory only.
// Runtime code should prefer manifest/runtime registry queries instead of these snapshots.

export type BundledPluginContractSnapshot = {
  pluginId: string;
  cliBackendIds: string[];
  providerIds: string[];
  speechProviderIds: string[];
  realtimeTranscriptionProviderIds: string[];
  realtimeVoiceProviderIds: string[];
  mediaUnderstandingProviderIds: string[];
  imageGenerationProviderIds: string[];
  videoGenerationProviderIds: string[];
  musicGenerationProviderIds: string[];
  webFetchProviderIds: string[];
  webSearchProviderIds: string[];
  toolNames: string[];
};

const BUNDLED_PLUGIN_METADATA_FOR_CAPABILITIES = listBundledPluginMetadata({
  includeChannelConfigs: false,
  includeSyntheticChannelConfigs: false,
});

export const BUNDLED_PLUGIN_CONTRACT_SNAPSHOTS: readonly BundledPluginContractSnapshot[] =
  BUNDLED_PLUGIN_METADATA_FOR_CAPABILITIES.map(({ manifest }) => ({
    pluginId: manifest.id,
    cliBackendIds: uniqueStrings(manifest.cliBackends, (value) => value.trim()),
    providerIds: uniqueStrings(manifest.providers, (value) => value.trim()),
    speechProviderIds: uniqueStrings(manifest.contracts?.speechProviders, (value) => value.trim()),
    realtimeTranscriptionProviderIds: uniqueStrings(
      manifest.contracts?.realtimeTranscriptionProviders,
      (value) => value.trim(),
    ),
    realtimeVoiceProviderIds: uniqueStrings(manifest.contracts?.realtimeVoiceProviders, (value) =>
      value.trim(),
    ),
    mediaUnderstandingProviderIds: uniqueStrings(
      manifest.contracts?.mediaUnderstandingProviders,
      (value) => value.trim(),
    ),
    imageGenerationProviderIds: uniqueStrings(
      manifest.contracts?.imageGenerationProviders,
      (value) => value.trim(),
    ),
    videoGenerationProviderIds: uniqueStrings(
      manifest.contracts?.videoGenerationProviders,
      (value) => value.trim(),
    ),
    musicGenerationProviderIds: uniqueStrings(
      manifest.contracts?.musicGenerationProviders,
      (value) => value.trim(),
    ),
    webFetchProviderIds: uniqueStrings(manifest.contracts?.webFetchProviders, (value) =>
      value.trim(),
    ),
    webSearchProviderIds: uniqueStrings(manifest.contracts?.webSearchProviders, (value) =>
      value.trim(),
    ),
    toolNames: uniqueStrings(manifest.contracts?.tools, (value) => value.trim()),
  }))
    .filter(
      (entry) =>
        entry.cliBackendIds.length > 0 ||
        entry.providerIds.length > 0 ||
        entry.speechProviderIds.length > 0 ||
        entry.realtimeTranscriptionProviderIds.length > 0 ||
        entry.realtimeVoiceProviderIds.length > 0 ||
        entry.mediaUnderstandingProviderIds.length > 0 ||
        entry.imageGenerationProviderIds.length > 0 ||
        entry.videoGenerationProviderIds.length > 0 ||
        entry.musicGenerationProviderIds.length > 0 ||
        entry.webFetchProviderIds.length > 0 ||
        entry.webSearchProviderIds.length > 0 ||
        entry.toolNames.length > 0,
    )
    .toSorted((left, right) => left.pluginId.localeCompare(right.pluginId));

export const BUNDLED_LEGACY_PLUGIN_ID_ALIASES = Object.fromEntries(
  BUNDLED_PLUGIN_METADATA_FOR_CAPABILITIES.flatMap(({ manifest }) =>
    (manifest.legacyPluginIds ?? []).map(
      (legacyPluginId) => [legacyPluginId, manifest.id] as const,
    ),
  ).toSorted(([left], [right]) => left.localeCompare(right)),
) as Readonly<Record<string, string>>;

export const BUNDLED_AUTO_ENABLE_PROVIDER_PLUGIN_IDS = Object.fromEntries(
  BUNDLED_PLUGIN_METADATA_FOR_CAPABILITIES.flatMap(({ manifest }) =>
    (manifest.autoEnableWhenConfiguredProviders ?? []).map((providerId) => [
      providerId,
      manifest.id,
    ]),
  ).toSorted(([left], [right]) => left.localeCompare(right)),
) as Readonly<Record<string, string>>;
