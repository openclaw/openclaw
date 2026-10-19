import type { FallbackAttempt } from "../agents/model-fallback.types.js";
import type {
  VideoGenerationIgnoredOverride,
  VideoGenerationNormalization,
  VideoGenerationRequest,
  VideoGenerationResult,
} from "./types.js";

export type GenerateVideoParams = Omit<VideoGenerationRequest, "provider" | "model"> & {
  modelOverride?: string;
  autoProviderFallback?: boolean;
};

export type GenerateVideoRuntimeResult = Omit<VideoGenerationResult, "model"> & {
  provider: string;
  model: string;
  attempts: FallbackAttempt[];
  normalization?: VideoGenerationNormalization;
  ignoredOverrides: VideoGenerationIgnoredOverride[];
};
