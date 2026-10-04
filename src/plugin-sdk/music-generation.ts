// Public music-generation helpers and types for provider plugins.

export type {
  GeneratedMusicAsset,
  MusicGenerationModeCapabilities,
  MusicGenerationProvider,
  MusicGenerationProviderCapabilities,
  MusicGenerationRequest,
  MusicGenerationSourceImage,
} from "../music-generation/types.js";
export {
  downloadGeneratedMusicAsset,
  extractGeneratedMusicFileCandidates,
  generatedMusicAssetFromBase64,
} from "../music-generation/provider-assets.js";
