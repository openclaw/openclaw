import { normalizeDurationToClosestMax } from "../media-generation/runtime-shared.js";
import { resolveMusicGenerationModeCapabilities } from "./capabilities.js";
import type {
  MusicGenerationIgnoredOverride,
  MusicGenerationNormalization,
  MusicGenerationOutputFormat,
  MusicGenerationProvider,
  MusicGenerationSourceImage,
} from "./types.js";

type ResolvedMusicGenerationOverrides = {
  lyrics?: string;
  instrumental?: boolean;
  durationSeconds?: number;
  format?: MusicGenerationOutputFormat;
  ignoredOverrides: MusicGenerationIgnoredOverride[];
  normalization?: MusicGenerationNormalization;
};

/** Sanitize caller overrides against provider capabilities before invoking a provider. */
export function resolveMusicGenerationOverrides(params: {
  provider: MusicGenerationProvider;
  model: string;
  lyrics?: string;
  instrumental?: boolean;
  durationSeconds?: number;
  format?: MusicGenerationOutputFormat;
  inputImages?: MusicGenerationSourceImage[];
}): ResolvedMusicGenerationOverrides {
  const { capabilities: caps } = resolveMusicGenerationModeCapabilities({
    provider: params.provider,
    inputImageCount: params.inputImages?.length ?? 0,
  });
  const ignoredOverrides: MusicGenerationIgnoredOverride[] = [];
  const normalization: MusicGenerationNormalization = {};
  let { lyrics, instrumental, durationSeconds, format } = params;

  if (!caps) {
    return {
      lyrics,
      instrumental,
      durationSeconds,
      format,
      ignoredOverrides,
    };
  }

  if (
    lyrics?.trim() &&
    !(caps.supportsLyricsByModel?.[params.model] ?? caps.supportsLyrics === true)
  ) {
    ignoredOverrides.push({ key: "lyrics", value: lyrics });
    lyrics = undefined;
  }

  if (
    typeof instrumental === "boolean" &&
    !(caps.supportsInstrumentalByModel?.[params.model] ?? caps.supportsInstrumental === true)
  ) {
    ignoredOverrides.push({ key: "instrumental", value: instrumental });
    instrumental = undefined;
  }

  if (typeof durationSeconds === "number" && !caps.supportsDuration) {
    ignoredOverrides.push({ key: "durationSeconds", value: durationSeconds });
    durationSeconds = undefined;
  } else if (typeof durationSeconds === "number") {
    const normalizedDurationSeconds = normalizeDurationToClosestMax(
      durationSeconds,
      caps.maxDurationSeconds,
    );
    if (
      typeof normalizedDurationSeconds === "number" &&
      normalizedDurationSeconds !== durationSeconds
    ) {
      normalization.durationSeconds = {
        requested: durationSeconds,
        applied: normalizedDurationSeconds,
      };
    }
    durationSeconds = normalizedDurationSeconds;
  }

  if (format) {
    const supportedFormats =
      caps.supportedFormatsByModel?.[params.model] ?? caps.supportedFormats ?? [];
    // An empty supportedFormats list means the provider validates formats internally.
    if (
      !caps.supportsFormat ||
      (supportedFormats.length > 0 && !supportedFormats.includes(format))
    ) {
      ignoredOverrides.push({ key: "format", value: format });
      format = undefined;
    }
  }

  return {
    lyrics,
    instrumental,
    durationSeconds,
    format,
    ignoredOverrides,
    normalization: normalization.durationSeconds ? normalization : undefined,
  };
}
