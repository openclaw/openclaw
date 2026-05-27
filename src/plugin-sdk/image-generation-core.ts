// Shared image-generation implementation helpers for bundled and third-party plugins.

export type { AuthProfileStore } from "../agents/auth-profiles.js";
export type { FallbackAttempt } from "../agents/model-fallback.types.js";
export type { ImageGenerationProviderPlugin } from "../plugins/types.js";
export type {
  GeneratedImageAsset,
  ImageGenerationProvider,
  ImageGenerationResolution,
  ImageGenerationRequest,
  ImageGenerationResult,
  ImageGenerationSourceImage,
} from "../image-generation/types.js";
export type { OpenClawConfig } from "../config/config.js";

export { describeFailoverError, isFailoverError } from "../agents/failover-error.js";
export { resolveApiKeyForProvider } from "../agents/model-auth.js";
export {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
export { parseGeminiAuth } from "../infra/gemini-auth.js";
export {
  getImageGenerationProvider,
  listImageGenerationProviders,
} from "../image-generation/provider-registry.js";
export { parseImageGenerationModelRef } from "../image-generation/model-ref.js";
export { createSubsystemLogger } from "../logging/subsystem.js";
export { normalizeGoogleModelId } from "./google.js";
export { OPENAI_DEFAULT_IMAGE_MODEL } from "./openai.js";
export { getProviderEnvVars } from "../secrets/provider-env-vars.js";
