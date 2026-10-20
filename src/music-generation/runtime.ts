import { resolveAgentModelTimeoutMsValue } from "../config/model-input.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createMediaProviderLookup } from "../media-generation/provider-registry.js";
import type {
  getMusicGenerationProvider,
  listMusicGenerationProviders,
} from "../media-generation/registry.js";
import {
  buildMediaGenerationNormalizationMetadata,
  resolveReferenceImageCapabilityError,
  runMediaGenerationCandidates,
} from "../media-generation/runtime-shared.js";
import { withAcquiredPluginCapabilityProviders } from "../plugins/capability-provider-acquisition.js";
import { resolveMusicGenerationOverrides } from "./normalization.js";
import type { GenerateMusicParams, GenerateMusicRuntimeResult } from "./runtime-types.js";
import type { MusicGenerationResult } from "./types.js";

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
        const sanitized = resolveMusicGenerationOverrides({
          provider,
          model: candidate.model,
          lyrics: params.lyrics,
          instrumental: params.instrumental,
          durationSeconds: params.durationSeconds,
          format: params.format,
          inputImages: params.inputImages,
        });
        const result: MusicGenerationResult = await provider.generateMusic({
          provider: candidate.provider,
          model: candidate.model,
          prompt: params.prompt,
          cfg: params.cfg,
          agentDir: params.agentDir,
          authStore: params.authStore,
          lyrics: sanitized.lyrics,
          instrumental: sanitized.instrumental,
          durationSeconds: sanitized.durationSeconds,
          format: sanitized.format,
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
          normalization: sanitized.normalization,
          metadata: {
            ...result.metadata,
            ...buildMediaGenerationNormalizationMetadata({
              normalization: sanitized.normalization,
            }),
          },
          ignoredOverrides: sanitized.ignoredOverrides,
        };
      };
    },
  });
}
