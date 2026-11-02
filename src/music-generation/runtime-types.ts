import type { FallbackAttempt } from "../agents/model-fallback.types.js";
import type {
  MusicGenerationIgnoredOverride,
  MusicGenerationNormalization,
  MusicGenerationRequest,
  MusicGenerationResult,
} from "./types.js";

export type GenerateMusicParams = Omit<MusicGenerationRequest, "provider" | "model"> & {
  modelOverride?: string;
  autoProviderFallback?: boolean;
};

export type GenerateMusicRuntimeResult = Omit<MusicGenerationResult, "model"> & {
  provider: string;
  model: string;
  attempts: FallbackAttempt[];
  normalization?: MusicGenerationNormalization;
  ignoredOverrides: MusicGenerationIgnoredOverride[];
};
