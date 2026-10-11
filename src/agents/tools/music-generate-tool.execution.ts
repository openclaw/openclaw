/** Persists complete music buffers and their metadata before task completion. */
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveGeneratedMediaMaxBytes } from "../../media/configured-max-bytes.js";
import { probeMediaFilesWithinBudget } from "../../media/media-probe.js";
import type { GenerateMusicParams } from "../../music-generation/runtime-types.js";
import { generateMusic } from "../../music-generation/runtime.js";
import type {
  MusicGenerationProvider,
  MusicGenerationSourceImage,
} from "../../music-generation/types.js";
import {
  sanitizeGeneratedMediaDisplayText,
  type AgentGeneratedAttachment,
} from "../generated-attachments.js";
import { persistGeneratedMediaBuffers } from "./generated-media-batch-persistence.js";
import type { MediaGenerationTaskHandle } from "./media-generate-background-shared.js";
import { musicGenerationTaskLifecycle } from "./media-generate-background.js";
import {
  buildMediaGenerateToolExecutionResult,
  buildMediaGenerationDurationDetails,
  buildSavedMediaAttachment,
  type MediaGenerateToolExecutionResult,
} from "./media-generate-result-shared.js";
import {
  buildMediaReferenceDetails,
  createCapabilityProviderRuntimeDeps,
  type LoadedMediaToolReference,
} from "./media-tool-shared.js";

const log = createSubsystemLogger("agents/tools/music-generate");
const GENERATED_MUSIC_MEDIA_SUBDIR = "tool-music-generation";
const DEFAULT_MUSIC_GENERATION_TIMEOUT_MS = 300_000;
const MIN_MUSIC_GENERATION_TIMEOUT_MS = 120_000;
const GENERATED_MUSIC_PROBE_BUDGET_MS = 3000;
const GENERATED_MUSIC_PROBE_CONCURRENCY = 2;
const MAX_GENERATED_MUSIC_PROBES = 8;

type MusicGenerationTimeoutNormalization = {
  requested: number;
  applied: number;
  minimum: number;
};

export function normalizeMusicGenerationTimeoutMs(timeoutMs: number | undefined): {
  timeoutMs: number;
  normalization?: MusicGenerationTimeoutNormalization;
  message?: string;
} {
  if (timeoutMs === undefined || timeoutMs >= MIN_MUSIC_GENERATION_TIMEOUT_MS) {
    return { timeoutMs: timeoutMs ?? DEFAULT_MUSIC_GENERATION_TIMEOUT_MS };
  }

  const normalization = {
    requested: timeoutMs,
    applied: MIN_MUSIC_GENERATION_TIMEOUT_MS,
    minimum: MIN_MUSIC_GENERATION_TIMEOUT_MS,
  };
  const message = `Timeout normalized: requested ${timeoutMs}ms; used ${MIN_MUSIC_GENERATION_TIMEOUT_MS}ms.`;
  log.warn("music_generate timeoutMs is below provider minimum; using minimum", {
    requestedTimeoutMs: timeoutMs,
    appliedTimeoutMs: MIN_MUSIC_GENERATION_TIMEOUT_MS,
    minimumTimeoutMs: MIN_MUSIC_GENERATION_TIMEOUT_MS,
  });
  return {
    timeoutMs: MIN_MUSIC_GENERATION_TIMEOUT_MS,
    normalization,
    message,
  };
}

export async function executeMusicGenerationJob(params: {
  request: Omit<GenerateMusicParams, "authStore"> & { timeoutMs: number };
  filename?: string;
  loadedReferenceImages: LoadedMediaToolReference<MusicGenerationSourceImage>[];
  taskHandle: MediaGenerationTaskHandle | null;
  timeoutNormalization?: MusicGenerationTimeoutNormalization;
  providers?: MusicGenerationProvider[];
}): Promise<MediaGenerateToolExecutionResult> {
  const { request } = params;
  musicGenerationTaskLifecycle.recordTaskProgress({
    handle: params.taskHandle,
    progressSummary: "Generating music",
  });
  const result = await generateMusic(
    request,
    createCapabilityProviderRuntimeDeps(params.providers),
  );
  musicGenerationTaskLifecycle.recordTaskProgress({
    handle: params.taskHandle,
    progressSummary: "Saving generated music",
  });
  const savedTracks = await persistGeneratedMediaBuffers({
    assets: result.tracks,
    subdir: GENERATED_MUSIC_MEDIA_SUBDIR,
    maxBytes: resolveGeneratedMediaMaxBytes(request.cfg, "audio"),
    filename: params.filename,
  });
  const ignoredOverrides = result.ignoredOverrides ?? [];
  const ignoredOverrideKeys = new Set(ignoredOverrides.map((entry) => entry.key));
  const duration = buildMediaGenerationDurationDetails(
    "music",
    result,
    request.durationSeconds,
    ignoredOverrideKeys,
  );
  const savedTrackMetadata = await probeMediaFilesWithinBudget(
    savedTracks.map((track) => ({ filePath: track.path, kind: "audio" })),
    {
      budgetMs: GENERATED_MUSIC_PROBE_BUDGET_MS,
      concurrency: GENERATED_MUSIC_PROBE_CONCURRENCY,
      maxProbes: MAX_GENERATED_MUSIC_PROBES,
    },
  );
  const attachments: AgentGeneratedAttachment[] = savedTracks.map((track, index) => ({
    ...buildSavedMediaAttachment("audio", track),
    ...(typeof duration.applied === "number" ? { durationMs: duration.applied * 1000 } : {}),
    ...savedTrackMetadata[index],
  }));
  const messages = [
    ...(params.timeoutNormalization
      ? [
          `Timeout normalized: requested ${params.timeoutNormalization.requested}ms; used ${params.timeoutNormalization.applied}ms.`,
        ]
      : []),
    duration.message,
    ...(result.lyrics?.length
      ? [
          "Lyrics returned.",
          ...result.lyrics.flatMap((lyric) =>
            lyric
              .replace(/\r\n?|[\u2028\u2029]/gu, "\n")
              .split("\n")
              .map((line) =>
                sanitizeGeneratedMediaDisplayText(line)
                  .replace(/^(\s*)(media):/iu, "$1$2：")
                  // An open provider fence would swallow the trusted attachment lines appended below.
                  .replace(/^( {0,3})(`{3,}|~{3,})/u, "$1\\$2"),
              ),
          ),
        ]
      : []),
  ];
  return buildMediaGenerateToolExecutionResult({
    kind: "music",
    result,
    attachments,
    mediaUrls: savedTracks.map((media) => media.path),
    messages,
    taskHandle: params.taskHandle,
    details: {
      ...(!ignoredOverrideKeys.has("lyrics") && request.lyrics
        ? { requestedLyrics: request.lyrics }
        : {}),
      ...(!ignoredOverrideKeys.has("instrumental") && typeof request.instrumental === "boolean"
        ? { instrumental: request.instrumental }
        : {}),
      ...duration.details,
      ...(!ignoredOverrideKeys.has("format") && request.format ? { format: request.format } : {}),
      ...(params.filename ? { filename: params.filename } : {}),
      timeoutMs: request.timeoutMs,
      ...(params.timeoutNormalization
        ? {
            requestedTimeoutMs: params.timeoutNormalization.requested,
            timeoutNormalization: params.timeoutNormalization,
          }
        : {}),
      ...buildMediaReferenceDetails(params.loadedReferenceImages, "image"),
      ...(result.lyrics?.length ? { lyrics: result.lyrics } : {}),
    },
  });
}
