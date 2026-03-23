// Shared image-generation implementation helpers for bundled and third-party plugins.

export type { ImageGenerationProviderPlugin } from "../plugins/types.js";
export type {
  GeneratedImageAsset,
  ImageGenerationProvider,
  ImageGenerationResolution,
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageGenerationSourceImage,
} from "../image-generation/types.js";

export { resolveApiKeyForProvider } from "../agents/model-auth.js";
export { normalizeGoogleModelId } from "../agents/model-id-normalization.js";
export { parseGeminiAuth } from "../infra/gemini-auth.js";
export { OPENAI_DEFAULT_IMAGE_MODEL } from "../providers/openai-defaults.js";
