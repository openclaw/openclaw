export type {
  MusicGenerationProvider,
  MusicGenerationRequest,
} from "../music-generation/provider-types.js";
export type {
  GeneratedMusicAsset,
  MusicGenerationModeCapabilities,
  MusicGenerationProviderCapabilities,
  MusicGenerationSourceImage,
} from "../music-generation/types.js";
export {
  downloadGeneratedMusicAsset,
  extractGeneratedMusicFileCandidates,
  generatedMusicAssetFromBase64,
} from "../music-generation/provider-assets.js";
export {
  buildGoogleMusicGenerationBody,
  parseGoogleMusicGenerationResponse,
} from "../music-generation/google-music.js";
// A dispatched billable operation may not be replayed after an uncertain response.
export { recordModelFallbackStop } from "../agents/model-fallback-stop.js";
