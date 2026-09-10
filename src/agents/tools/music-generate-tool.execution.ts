/** Persists complete music buffers and their metadata before task completion. */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveGeneratedMediaMaxBytes } from "../../media/configured-max-bytes.js";
import { probeMediaFilesWithinBudget } from "../../media/media-probe.js";
import { saveMediaBuffer } from "../../media/store.js";
import { generateMusic } from "../../music-generation/runtime.js";
import type {
  MusicGenerationOutputFormat,
  MusicGenerationProvider,
  MusicGenerationSourceImage,
} from "../../music-generation/types.js";
import {
  formatGeneratedAttachmentLines,
  sanitizeGeneratedMediaDisplayText,
  type AgentGeneratedAttachment,
} from "../generated-attachments.js";
import { persistGeneratedMediaBatch } from "./generated-media-batch-persistence.js";
import {
  musicGenerationTaskLifecycle,
  type MusicGenerationTaskHandle,
} from "./media-generate-background.js";
import {
  buildMediaReferenceDetails,
  buildTaskRunDetails,
  createCapabilityProviderRuntimeDeps,
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
  timeoutMs?: number;
  normalization?: MusicGenerationTimeoutNormalization;
  message?: string;
} {
  if (timeoutMs === undefined) {
    return { timeoutMs: DEFAULT_MUSIC_GENERATION_TIMEOUT_MS };
  }
  if (timeoutMs >= MIN_MUSIC_GENERATION_TIMEOUT_MS) {
    return { timeoutMs };
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

type LoadedReferenceImage = {
  sourceImage: MusicGenerationSourceImage;
  resolvedInput: string;
  rewrittenFrom?: string;
};

type ExecutedMusicGeneration = {
  provider: string;
  model: string;
  count: number;
  attachments: AgentGeneratedAttachment[];
  contentText: string;
  details: Record<string, unknown>;
  wakeResult: string;
};

export async function executeMusicGenerationJob(params: {
  effectiveCfg: OpenClawConfig;
  prompt: string;
  agentDir?: string;
  model?: string;
  lyrics?: string;
  instrumental?: boolean;
  durationSeconds?: number;
  format?: MusicGenerationOutputFormat;
  filename?: string;
  loadedReferenceImages: LoadedReferenceImage[];
  taskHandle?: MusicGenerationTaskHandle | null;
  autoProviderFallback?: boolean;
  timeoutMs?: number;
  timeoutNormalization?: MusicGenerationTimeoutNormalization;
  providers?: MusicGenerationProvider[];
}): Promise<ExecutedMusicGeneration> {
  if (params.taskHandle) {
    musicGenerationTaskLifecycle.recordTaskProgress({
      handle: params.taskHandle,
      progressSummary: "Generating music",
    });
  }
  const result = await generateMusic(
    {
      cfg: params.effectiveCfg,
      prompt: params.prompt,
      agentDir: params.agentDir,
      modelOverride: params.model,
      lyrics: params.lyrics,
      instrumental: params.instrumental,
      durationSeconds: params.durationSeconds,
      format: params.format,
      inputImages: params.loadedReferenceImages.map((entry) => entry.sourceImage),
      autoProviderFallback: params.autoProviderFallback,
      timeoutMs: params.timeoutMs,
    },
    createCapabilityProviderRuntimeDeps(params.providers),
  );
  if (params.taskHandle) {
    musicGenerationTaskLifecycle.recordTaskProgress({
      handle: params.taskHandle,
      progressSummary: "Saving generated music",
    });
  }
  const mediaMaxBytes = resolveGeneratedMediaMaxBytes(params.effectiveCfg, "audio");
  const savedTracks = await persistGeneratedMediaBatch({
    subdir: GENERATED_MUSIC_MEDIA_SUBDIR,
    mode: "concurrent",
    saves: result.tracks.map((track) => async () => {
      const savedMedia = await saveMediaBuffer(
        track.buffer,
        track.mimeType,
        GENERATED_MUSIC_MEDIA_SUBDIR,
        mediaMaxBytes,
        params.filename || track.fileName,
      );
      return { value: savedMedia, savedMedia };
    }),
  });
  const ignoredOverrides = result.ignoredOverrides ?? [];
  const ignoredOverrideKeys = new Set(ignoredOverrides.map((entry) => entry.key));
  const requestedDurationSeconds =
    result.normalization?.durationSeconds?.requested ??
    (typeof result.metadata?.requestedDurationSeconds === "number" &&
    Number.isFinite(result.metadata.requestedDurationSeconds)
      ? result.metadata.requestedDurationSeconds
      : params.durationSeconds);
  const runtimeNormalizedDurationSeconds =
    result.normalization?.durationSeconds?.applied ??
    (typeof result.metadata?.normalizedDurationSeconds === "number" &&
    Number.isFinite(result.metadata.normalizedDurationSeconds)
      ? result.metadata.normalizedDurationSeconds
      : undefined);
  const appliedDurationSeconds =
    runtimeNormalizedDurationSeconds ??
    (!ignoredOverrideKeys.has("durationSeconds") && typeof params.durationSeconds === "number"
      ? params.durationSeconds
      : undefined);
  const displayProvider = sanitizeGeneratedMediaDisplayText(result.provider);
  const displayModel = sanitizeGeneratedMediaDisplayText(result.model);
  const warning =
    ignoredOverrides.length > 0
      ? `Ignored unsupported overrides for ${displayProvider}/${displayModel}: ${ignoredOverrides
          .map(
            (entry) =>
              `${sanitizeGeneratedMediaDisplayText(entry.key)}=${sanitizeGeneratedMediaDisplayText(String(entry.value))}`,
          )
          .join(", ")}.`
      : undefined;
  const savedTrackMetadata = await probeMediaFilesWithinBudget(
    savedTracks.map((track) => ({ filePath: track.path, kind: "audio" })),
    {
      budgetMs: GENERATED_MUSIC_PROBE_BUDGET_MS,
      concurrency: GENERATED_MUSIC_PROBE_CONCURRENCY,
      maxProbes: MAX_GENERATED_MUSIC_PROBES,
    },
  );
  const attachments: AgentGeneratedAttachment[] = savedTracks.map((track, index) => ({
    type: "audio",
    path: track.path,
    mimeType: track.contentType,
    name: result.tracks[index]?.fileName,
    sizeBytes: track.size,
    ...(typeof appliedDurationSeconds === "number"
      ? { durationMs: appliedDurationSeconds * 1000 }
      : {}),
    ...savedTrackMetadata[index],
  }));
  const lines = [
    `Generated ${savedTracks.length} track${savedTracks.length === 1 ? "" : "s"} with ${displayProvider}/${displayModel}.`,
    ...(warning ? [`Warning: ${warning}`] : []),
    ...(params.timeoutNormalization
      ? [
          `Timeout normalized: requested ${params.timeoutNormalization.requested}ms; used ${params.timeoutNormalization.applied}ms.`,
        ]
      : []),
    typeof requestedDurationSeconds === "number" &&
    typeof appliedDurationSeconds === "number" &&
    requestedDurationSeconds !== appliedDurationSeconds
      ? `Duration normalized: requested ${requestedDurationSeconds}s; used ${appliedDurationSeconds}s.`
      : null,
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
    ...formatGeneratedAttachmentLines(attachments),
  ].filter((entry): entry is string => Boolean(entry));
  return {
    provider: result.provider,
    model: result.model,
    count: savedTracks.length,
    attachments,
    contentText: lines.join("\n"),
    wakeResult: lines.join("\n"),
    details: {
      provider: result.provider,
      model: result.model,
      count: savedTracks.length,
      media: {
        mediaUrls: savedTracks.map((track) => track.path),
        attachments,
      },
      attachments,
      paths: savedTracks.map((track) => track.path),
      ...buildTaskRunDetails(params.taskHandle),
      ...(!ignoredOverrideKeys.has("lyrics") && params.lyrics
        ? { requestedLyrics: params.lyrics }
        : {}),
      ...(!ignoredOverrideKeys.has("instrumental") && typeof params.instrumental === "boolean"
        ? { instrumental: params.instrumental }
        : {}),
      ...(typeof appliedDurationSeconds === "number"
        ? { durationSeconds: appliedDurationSeconds }
        : {}),
      ...(typeof requestedDurationSeconds === "number" &&
      typeof appliedDurationSeconds === "number" &&
      requestedDurationSeconds !== appliedDurationSeconds
        ? { requestedDurationSeconds }
        : {}),
      ...(!ignoredOverrideKeys.has("format") && params.format ? { format: params.format } : {}),
      ...(params.filename ? { filename: params.filename } : {}),
      ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
      ...(params.timeoutNormalization
        ? {
            requestedTimeoutMs: params.timeoutNormalization.requested,
            timeoutNormalization: params.timeoutNormalization,
          }
        : {}),
      ...buildMediaReferenceDetails({
        entries: params.loadedReferenceImages,
        singleKey: "image",
        pluralKey: "images",
        getResolvedInput: (entry) => entry.resolvedInput,
      }),
      ...(result.lyrics?.length ? { lyrics: result.lyrics } : {}),
      attempts: result.attempts,
      ...(result.normalization ? { normalization: result.normalization } : {}),
      metadata: result.metadata,
      ...(warning ? { warning } : {}),
      ...(ignoredOverrides.length > 0 ? { ignoredOverrides } : {}),
    },
  };
}
