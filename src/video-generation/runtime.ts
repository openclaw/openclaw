import type { AuthProfileStore } from "../agents/auth-profiles.js";
import { describeFailoverError, isFailoverError } from "../agents/failover-error.js";
import type { FallbackAttempt } from "../agents/model-fallback.types.js";
import type { OpenClawConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  buildNoCapabilityModelConfiguredMessage,
  resolveCapabilityModelCandidates,
  throwCapabilityGenerationFailure,
} from "../media-generation/runtime-shared.js";
import {
  normalizeVideoGenerationDuration,
  resolveVideoGenerationSupportedDurations,
} from "./duration-support.js";
import { parseVideoGenerationModelRef } from "./model-ref.js";
import { getVideoGenerationProvider, listVideoGenerationProviders } from "./provider-registry.js";
import type {
  GeneratedVideoAsset,
  VideoGenerationIgnoredOverride,
  VideoGenerationResolution,
  VideoGenerationResult,
  VideoGenerationSourceAsset,
} from "./types.js";

const log = createSubsystemLogger("video-generation");

export type GenerateVideoParams = {
  cfg: OpenClawConfig;
  prompt: string;
  agentDir?: string;
  authStore?: AuthProfileStore;
  modelOverride?: string;
  size?: string;
  aspectRatio?: string;
  resolution?: VideoGenerationResolution;
  durationSeconds?: number;
  audio?: boolean;
  watermark?: boolean;
  inputImages?: VideoGenerationSourceAsset[];
  inputVideos?: VideoGenerationSourceAsset[];
};

export type GenerateVideoRuntimeResult = {
  videos: GeneratedVideoAsset[];
  provider: string;
  model: string;
  attempts: FallbackAttempt[];
  metadata?: Record<string, unknown>;
  ignoredOverrides: VideoGenerationIgnoredOverride[];
};

function buildNoVideoGenerationModelConfiguredMessage(cfg: OpenClawConfig): string {
  return buildNoCapabilityModelConfiguredMessage({
    capabilityLabel: "video-generation",
    modelConfigKey: "videoGenerationModel",
    providers: listVideoGenerationProviders(cfg),
  });
}

export function listRuntimeVideoGenerationProviders(params?: { config?: OpenClawConfig }) {
  return listVideoGenerationProviders(params?.config);
}

function resolveProviderVideoGenerationOverrides(params: {
  provider: NonNullable<ReturnType<typeof getVideoGenerationProvider>>;
  size?: string;
  aspectRatio?: string;
  resolution?: VideoGenerationResolution;
  audio?: boolean;
  watermark?: boolean;
}) {
  const caps = params.provider.capabilities;
  const ignoredOverrides: VideoGenerationIgnoredOverride[] = [];
  let size = params.size;
  let aspectRatio = params.aspectRatio;
  let resolution = params.resolution;
  let audio = params.audio;
  let watermark = params.watermark;

  if (size && !caps.supportsSize) {
    ignoredOverrides.push({ key: "size", value: size });
    size = undefined;
  }

  if (aspectRatio && !caps.supportsAspectRatio) {
    ignoredOverrides.push({ key: "aspectRatio", value: aspectRatio });
    aspectRatio = undefined;
  }

  if (resolution && !caps.supportsResolution) {
    ignoredOverrides.push({ key: "resolution", value: resolution });
    resolution = undefined;
  }

  if (typeof audio === "boolean" && !caps.supportsAudio) {
    ignoredOverrides.push({ key: "audio", value: audio });
    audio = undefined;
  }

  if (typeof watermark === "boolean" && !caps.supportsWatermark) {
    ignoredOverrides.push({ key: "watermark", value: watermark });
    watermark = undefined;
  }

  return {
    size,
    aspectRatio,
    resolution,
    audio,
    watermark,
    ignoredOverrides,
  };
}

export async function generateVideo(
  params: GenerateVideoParams,
): Promise<GenerateVideoRuntimeResult> {
  const candidates = resolveCapabilityModelCandidates({
    cfg: params.cfg,
    modelConfig: params.cfg.agents?.defaults?.videoGenerationModel,
    modelOverride: params.modelOverride,
    parseModelRef: parseVideoGenerationModelRef,
  });
  if (candidates.length === 0) {
    throw new Error(buildNoVideoGenerationModelConfiguredMessage(params.cfg));
  }

  const attempts: FallbackAttempt[] = [];
  let lastError: unknown;

  for (const candidate of candidates) {
    const provider = getVideoGenerationProvider(candidate.provider, params.cfg);
    if (!provider) {
      const error = `No video-generation provider registered for ${candidate.provider}`;
      attempts.push({
        provider: candidate.provider,
        model: candidate.model,
        error,
      });
      lastError = new Error(error);
      continue;
    }

    try {
      const sanitized = resolveProviderVideoGenerationOverrides({
        provider,
        size: params.size,
        aspectRatio: params.aspectRatio,
        resolution: params.resolution,
        audio: params.audio,
        watermark: params.watermark,
      });
      const requestedDurationSeconds =
        typeof params.durationSeconds === "number" && Number.isFinite(params.durationSeconds)
          ? Math.max(1, Math.round(params.durationSeconds))
          : undefined;
      const normalizedDurationSeconds = normalizeVideoGenerationDuration({
        provider,
        model: candidate.model,
        durationSeconds: requestedDurationSeconds,
      });
      const supportedDurationSeconds = resolveVideoGenerationSupportedDurations({
        provider,
        model: candidate.model,
      });
      const result: VideoGenerationResult = await provider.generateVideo({
        provider: candidate.provider,
        model: candidate.model,
        prompt: params.prompt,
        cfg: params.cfg,
        agentDir: params.agentDir,
        authStore: params.authStore,
        size: sanitized.size,
        aspectRatio: sanitized.aspectRatio,
        resolution: sanitized.resolution,
        durationSeconds: normalizedDurationSeconds,
        audio: sanitized.audio,
        watermark: sanitized.watermark,
        inputImages: params.inputImages,
        inputVideos: params.inputVideos,
      });
      if (!Array.isArray(result.videos) || result.videos.length === 0) {
        throw new Error("Video generation provider returned no videos.");
      }
      return {
        videos: result.videos,
        provider: candidate.provider,
        model: result.model ?? candidate.model,
        attempts,
        ignoredOverrides: sanitized.ignoredOverrides,
        metadata:
          typeof requestedDurationSeconds === "number" &&
          typeof normalizedDurationSeconds === "number" &&
          requestedDurationSeconds !== normalizedDurationSeconds
            ? {
                ...result.metadata,
                requestedDurationSeconds,
                normalizedDurationSeconds,
                ...(supportedDurationSeconds ? { supportedDurationSeconds } : {}),
              }
            : result.metadata,
      };
    } catch (err) {
      lastError = err;
      const described = isFailoverError(err) ? describeFailoverError(err) : undefined;
      attempts.push({
        provider: candidate.provider,
        model: candidate.model,
        error: described?.message ?? (err instanceof Error ? err.message : String(err)),
        reason: described?.reason,
        status: described?.status,
        code: described?.code,
      });
      log.debug(`video-generation candidate failed: ${candidate.provider}/${candidate.model}`);
    }
  }

  throwCapabilityGenerationFailure({
    capabilityLabel: "video generation",
    attempts,
    lastError,
  });
}
