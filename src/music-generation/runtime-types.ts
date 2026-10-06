import type { FallbackAttempt } from "../agents/model-fallback.types.js";
import type {
  MusicGenerationIgnoredOverride,
  MusicGenerationNormalization,
  MusicGenerationRequest,
  MusicGenerationResult,
} from "./types.js";

/** Parameters accepted by the core music generation runtime. */
export type GenerateMusicParams = Omit<MusicGenerationRequest, "provider" | "model"> & {
  modelOverride?: string;
  autoProviderFallback?: boolean;
};

/** Result returned after a successful runtime provider attempt. */
export type GenerateMusicRuntimeResult = Omit<MusicGenerationResult, "model"> & {
  provider: string;
  model: string;
  attempts: FallbackAttempt[];
  normalization?: MusicGenerationNormalization;
  ignoredOverrides: MusicGenerationIgnoredOverride[];
};
