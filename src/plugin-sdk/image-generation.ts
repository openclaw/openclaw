// Public image-generation helpers and types for provider plugins.

export type {
  GeneratedImageAsset,
  ImageGenerationProvider,
  ImageGenerationResolution,
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageGenerationSourceImage,
} from "../image-generation/types.js";

export { buildFalImageGenerationProvider } from "../../extensions/fal/image-generation-provider.js";
export { buildGoogleImageGenerationProvider } from "../../extensions/google/image-generation-provider.js";
export { buildOpenAIImageGenerationProvider } from "../../extensions/openai/image-generation-provider.js";
