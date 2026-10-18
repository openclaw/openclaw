import { resolveMediaGeometryOverrides } from "../media-generation/geometry-normalization.js";
import { resolveVideoGenerationModeCapabilities } from "./capabilities.js";
import {
  normalizeVideoGenerationDuration,
  resolveVideoGenerationSupportedDurations,
  selectSupportedVideoDuration,
} from "./duration-support.js";
import type {
  VideoGenerationIgnoredOverride,
  VideoGenerationNormalization,
  VideoGenerationProvider,
  VideoGenerationResolution,
} from "./types.js";

type ResolvedVideoGenerationOverrides = {
  size?: string;
  aspectRatio?: string;
  resolution?: VideoGenerationResolution;
  durationSeconds?: number;
  supportedDurationSeconds?: readonly number[];
  audio?: boolean;
  watermark?: boolean;
  ignoredOverrides: VideoGenerationIgnoredOverride[];
  normalization?: VideoGenerationNormalization;
};

export function resolveVideoGenerationOverrides(params: {
  provider: VideoGenerationProvider;
  model: string;
  size?: string;
  aspectRatio?: string;
  resolution?: VideoGenerationResolution;
  durationSeconds?: number;
  audio?: boolean;
  watermark?: boolean;
  inputImageCount?: number;
  inputVideoCount?: number;
}): ResolvedVideoGenerationOverrides {
  const { capabilities: caps } = resolveVideoGenerationModeCapabilities({
    provider: params.provider,
    model: params.model,
    inputImageCount: params.inputImageCount,
    inputVideoCount: params.inputVideoCount,
  });
  const sanitized = resolveMediaGeometryOverrides({
    size: params.size,
    aspectRatio: params.aspectRatio,
    resolution: params.resolution,
    capabilities: caps,
    reportUnrecognizedOverrides: true,
    useAspectRatioForRequestedSize: true,
  });
  const ignoredOverrides: VideoGenerationIgnoredOverride[] = sanitized.ignoredOverrides;
  const normalization: VideoGenerationNormalization = sanitized.normalization;
  let { audio, watermark } = params;

  if (caps && typeof audio === "boolean" && !caps.supportsAudio) {
    ignoredOverrides.push({ key: "audio", value: audio });
    audio = undefined;
  }
  if (caps && typeof watermark === "boolean" && !caps.supportsWatermark) {
    ignoredOverrides.push({ key: "watermark", value: watermark });
    watermark = undefined;
  }

  const requestedDurationSeconds = normalizeVideoGenerationDuration({
    durationSeconds: params.durationSeconds,
  });
  const supportedDurationSeconds = resolveVideoGenerationSupportedDurations({
    provider: params.provider,
    model: params.model,
    inputImageCount: params.inputImageCount ?? 0,
    inputVideoCount: params.inputVideoCount ?? 0,
  });
  const durationSeconds =
    requestedDurationSeconds !== undefined && supportedDurationSeconds
      ? selectSupportedVideoDuration(requestedDurationSeconds, supportedDurationSeconds)
      : requestedDurationSeconds;

  if (
    typeof requestedDurationSeconds === "number" &&
    typeof durationSeconds === "number" &&
    requestedDurationSeconds !== durationSeconds
  ) {
    normalization.durationSeconds = {
      requested: requestedDurationSeconds,
      applied: durationSeconds,
      ...(supportedDurationSeconds?.length ? { supportedValues: supportedDurationSeconds } : {}),
    };
  }

  return {
    size: sanitized.size,
    aspectRatio: sanitized.aspectRatio,
    resolution: sanitized.resolution,
    durationSeconds,
    supportedDurationSeconds,
    audio,
    watermark,
    ignoredOverrides,
    normalization: Object.keys(normalization).length ? normalization : undefined,
  };
}
