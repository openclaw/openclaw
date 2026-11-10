import type { PluginManifestContracts } from "./manifest-types.js";

export function createManifestProviderIdLists(contracts: PluginManifestContracts | undefined) {
  return {
    embeddingProviderIds: [...(contracts?.embeddingProviders ?? [])],
    speechProviderIds: [...(contracts?.speechProviders ?? [])],
    realtimeTranscriptionProviderIds: [...(contracts?.realtimeTranscriptionProviders ?? [])],
    realtimeVoiceProviderIds: [...(contracts?.realtimeVoiceProviders ?? [])],
    mediaUnderstandingProviderIds: [...(contracts?.mediaUnderstandingProviders ?? [])],
    transcriptSourceProviderIds: [...(contracts?.transcriptSourceProviders ?? [])],
    imageGenerationProviderIds: [...(contracts?.imageGenerationProviders ?? [])],
    videoGenerationProviderIds: [...(contracts?.videoGenerationProviders ?? [])],
    musicGenerationProviderIds: [...(contracts?.musicGenerationProviders ?? [])],
    webFetchProviderIds: [...(contracts?.webFetchProviders ?? [])],
    webSearchProviderIds: [...(contracts?.webSearchProviders ?? [])],
    migrationProviderIds: [...(contracts?.migrationProviders ?? [])],
  };
}
