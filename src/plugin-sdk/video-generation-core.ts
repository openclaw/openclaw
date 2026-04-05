// Shared video-generation implementation helpers for bundled and third-party plugins.

export type { AuthProfileStore } from "../agents/auth-profiles.js";
export type { FallbackAttempt } from "../agents/model-fallback.types.js";
export type { VideoGenerationProviderPlugin } from "../plugins/types.js";
export type {
  GeneratedVideoAsset,
  VideoGenerationProvider,
  VideoGenerationProviderConfiguredContext,
  VideoGenerationRequest,
  VideoGenerationResolution,
  VideoGenerationResult,
  VideoGenerationSourceAsset,
} from "../video-generation/types.js";
export type { OpenClawConfig } from "../config/config.js";

export { describeFailoverError, isFailoverError } from "../agents/failover-error.js";
export {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
export {
  getVideoGenerationProvider,
  listVideoGenerationProviders,
} from "../video-generation/provider-registry.js";
export { parseVideoGenerationModelRef } from "../video-generation/model-ref.js";
export { createSubsystemLogger } from "../logging/subsystem.js";
export { getProviderEnvVars } from "../secrets/provider-env-vars.js";
