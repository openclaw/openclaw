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
import { parseMusicGenerationModelRef } from "./model-ref.js";
import { getMusicGenerationProvider, listMusicGenerationProviders } from "./provider-registry.js";
import type {
  GeneratedMusicAsset,
  MusicGenerationIgnoredOverride,
  MusicGenerationOutputFormat,
  MusicGenerationResult,
  MusicGenerationSourceImage,
} from "./types.js";

const log = createSubsystemLogger("music-generation");

export type GenerateMusicParams = {
  cfg: OpenClawConfig;
  prompt: string;
  agentDir?: string;
  authStore?: AuthProfileStore;
  modelOverride?: string;
  lyrics?: string;
  instrumental?: boolean;
  durationSeconds?: number;
  format?: MusicGenerationOutputFormat;
  inputImages?: MusicGenerationSourceImage[];
};

export type GenerateMusicRuntimeResult = {
  tracks: GeneratedMusicAsset[];
  provider: string;
  model: string;
  attempts: FallbackAttempt[];
  lyrics?: string[];
  metadata?: Record<string, unknown>;
  ignoredOverrides: MusicGenerationIgnoredOverride[];
};

export function listRuntimeMusicGenerationProviders(params?: { config?: OpenClawConfig }) {
  return listMusicGenerationProviders(params?.config);
}

function resolveProviderMusicGenerationOverrides(params: {
  provider: NonNullable<ReturnType<typeof getMusicGenerationProvider>>;
  model: string;
  lyrics?: string;
  instrumental?: boolean;
  durationSeconds?: number;
  format?: MusicGenerationOutputFormat;
}) {
  const caps = params.provider.capabilities;
  const ignoredOverrides: MusicGenerationIgnoredOverride[] = [];
  let lyrics = params.lyrics;
  let instrumental = params.instrumental;
  let durationSeconds = params.durationSeconds;
  let format = params.format;

  if (lyrics?.trim() && !caps.supportsLyrics) {
    ignoredOverrides.push({ key: "lyrics", value: lyrics });
    lyrics = undefined;
  }

  if (typeof instrumental === "boolean" && !caps.supportsInstrumental) {
    ignoredOverrides.push({ key: "instrumental", value: instrumental });
    instrumental = undefined;
  }

  if (typeof durationSeconds === "number" && !caps.supportsDuration) {
    ignoredOverrides.push({ key: "durationSeconds", value: durationSeconds });
    durationSeconds = undefined;
  }

  if (format) {
    const supportedFormats =
      caps.supportedFormatsByModel?.[params.model] ?? caps.supportedFormats ?? [];
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
  };
}

export async function generateMusic(
  params: GenerateMusicParams,
): Promise<GenerateMusicRuntimeResult> {
  const candidates = resolveCapabilityModelCandidates({
    cfg: params.cfg,
    modelConfig: params.cfg.agents?.defaults?.musicGenerationModel,
    modelOverride: params.modelOverride,
    parseModelRef: parseMusicGenerationModelRef,
  });
  if (candidates.length === 0) {
    throw new Error(
      buildNoCapabilityModelConfiguredMessage({
        capabilityLabel: "music-generation",
        modelConfigKey: "musicGenerationModel",
        providers: listMusicGenerationProviders(params.cfg),
        fallbackSampleRef: "google/lyria-3-clip-preview",
      }),
    );
  }

  const attempts: FallbackAttempt[] = [];
  let lastError: unknown;

  for (const candidate of candidates) {
    const provider = getMusicGenerationProvider(candidate.provider, params.cfg);
    if (!provider) {
      const error = `No music-generation provider registered for ${candidate.provider}`;
      attempts.push({
        provider: candidate.provider,
        model: candidate.model,
        error,
      });
      lastError = new Error(error);
      continue;
    }

    try {
      const sanitized = resolveProviderMusicGenerationOverrides({
        provider,
        model: candidate.model,
        lyrics: params.lyrics,
        instrumental: params.instrumental,
        durationSeconds: params.durationSeconds,
        format: params.format,
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
      });
      if (!Array.isArray(result.tracks) || result.tracks.length === 0) {
        throw new Error("Music generation provider returned no tracks.");
      }
      return {
        tracks: result.tracks,
        provider: candidate.provider,
        model: result.model ?? candidate.model,
        attempts,
        lyrics: result.lyrics,
        metadata: result.metadata,
        ignoredOverrides: sanitized.ignoredOverrides,
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
      log.debug(`music-generation candidate failed: ${candidate.provider}/${candidate.model}`);
    }
  }

  throwCapabilityGenerationFailure({
    capabilityLabel: "music generation",
    attempts,
    lastError,
  });
}
