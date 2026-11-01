import {
  buildMediaGenerationNormalizationMetadata,
  normalizeDurationToClosestMax,
} from "../../packages/media-generation-core/src/normalization.js";
import { resolveAgentModelTimeoutMsValue } from "../config/model-input.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createMediaProviderLookup } from "../media-generation/provider-registry.js";
import type {
  getMusicGenerationProvider,
  listMusicGenerationProviders,
} from "../media-generation/registry.js";
import {
  resolveReferenceImageCapabilityError,
  runMediaGenerationCandidates,
} from "../media-generation/runtime-shared.js";
import { withAcquiredPluginCapabilityProviders } from "../plugins/capability-provider-acquisition.js";
import { resolveMusicGenerationModeCapabilities } from "./capabilities.js";
import type { GenerateMusicParams, GenerateMusicRuntimeResult } from "./runtime-types.js";
import type {
  MusicGenerationIgnoredOverride,
  MusicGenerationNormalization,
  MusicGenerationResult,
} from "./types.js";

const log = createSubsystemLogger("music-generation");

type MusicGenerationRuntimeDeps = {
  getProvider: typeof getMusicGenerationProvider;
  listProviders: typeof listMusicGenerationProviders;
};

/** Generate music with provider fallback and capability-aware request normalization. */
export async function generateMusic(
  params: GenerateMusicParams,
  deps?: MusicGenerationRuntimeDeps,
): Promise<GenerateMusicRuntimeResult> {
  if (deps) {
    return runMusicGeneration(params, deps);
  }
  return withAcquiredPluginCapabilityProviders(
    { key: "musicGenerationProviders", cfg: params.cfg },
    (providers) => runMusicGeneration(params, createMediaProviderLookup(providers)),
  );
}

async function runMusicGeneration(
  params: GenerateMusicParams,
  deps: MusicGenerationRuntimeDeps,
): Promise<GenerateMusicRuntimeResult> {
  const timeoutMs =
    params.timeoutMs ??
    resolveAgentModelTimeoutMsValue(params.cfg.agents?.defaults?.mediaModels?.music);

  return runMediaGenerationCandidates({
    request: params,
    listProviders: deps.listProviders,
    capability: "music",
    getProvider: (providerId) => deps.getProvider(providerId, params.cfg),
    onFailure: (attempt) => {
      log.warn(
        `music-generation candidate failed: ${attempt.provider}/${attempt.model}: ${attempt.error}`,
      );
    },
    prepareCandidate(candidate, provider) {
      const referenceImageError = resolveReferenceImageCapabilityError({
        candidateRef: `${candidate.provider}/${candidate.model}`,
        inputImageCount: params.inputImages?.length ?? 0,
        edit: provider.capabilities.edit,
      });
      if (referenceImageError) {
        log.debug(`music-generation candidate skipped: ${referenceImageError}`);
        return referenceImageError;
      }

      return async (attempts): Promise<GenerateMusicRuntimeResult> => {
        const caps = resolveMusicGenerationModeCapabilities({
          provider,
          inputImageCount: params.inputImages?.length ?? 0,
        });
        const ignoredOverrides: MusicGenerationIgnoredOverride[] = [];
        const normalization: MusicGenerationNormalization = {};
        let { lyrics, instrumental, durationSeconds, format } = params;
        if (caps) {
          if (
            lyrics?.trim() &&
            !(caps.supportsLyricsByModel?.[candidate.model] ?? caps.supportsLyrics === true)
          ) {
            ignoredOverrides.push({ key: "lyrics", value: lyrics });
            lyrics = undefined;
          }
          if (
            typeof instrumental === "boolean" &&
            !(
              caps.supportsInstrumentalByModel?.[candidate.model] ??
              caps.supportsInstrumental === true
            )
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
              caps.supportedFormatsByModel?.[candidate.model] ?? caps.supportedFormats ?? [];
            // An empty list means the provider validates formats internally.
            if (
              !caps.supportsFormat ||
              (supportedFormats.length > 0 && !supportedFormats.includes(format))
            ) {
              ignoredOverrides.push({ key: "format", value: format });
              format = undefined;
            }
          }
        }
        const appliedNormalization = normalization.durationSeconds ? normalization : undefined;
        const result: MusicGenerationResult = await provider.generateMusic({
          provider: candidate.provider,
          model: candidate.model,
          prompt: params.prompt,
          cfg: params.cfg,
          agentDir: params.agentDir,
          authStore: params.authStore,
          lyrics,
          instrumental,
          durationSeconds,
          format,
          inputImages: params.inputImages,
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        });
        if (!Array.isArray(result.tracks) || result.tracks.length === 0) {
          throw new Error("Music generation provider returned no tracks.");
        }
        const emptyTrackIndex = result.tracks.findIndex((track) => track.buffer.byteLength === 0);
        if (emptyTrackIndex >= 0) {
          throw new Error(
            `Music generation provider returned an empty track buffer at index ${emptyTrackIndex}.`,
          );
        }
        return {
          tracks: result.tracks,
          provider: candidate.provider,
          model: result.model ?? candidate.model,
          attempts,
          lyrics: result.lyrics,
          normalization: appliedNormalization,
          metadata: {
            ...result.metadata,
            ...buildMediaGenerationNormalizationMetadata({
              normalization: appliedNormalization,
            }),
          },
          ignoredOverrides,
        };
      };
    },
  });
}
