/** Completes video reference loading, generation, and ordered media persistence. */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SsrFPolicy } from "../../infra/net/ssrf.js";
import { resolveGeneratedMediaMaxBytes } from "../../media/configured-max-bytes.js";
import { probeMediaFilesWithinBudget } from "../../media/media-probe.js";
import { saveMediaBuffer } from "../../media/store.js";
import { SaveMediaSourceError } from "../../media/store.shared.js";
import { generateVideo } from "../../video-generation/runtime.js";
import type {
  GeneratedVideoAsset,
  VideoGenerationIgnoredOverride,
  VideoGenerationProvider,
  VideoGenerationResolution,
  VideoGenerationSourceAsset,
} from "../../video-generation/types.js";
import {
  formatGeneratedAttachmentLines,
  sanitizeGeneratedMediaDisplayText,
  type AgentGeneratedAttachment,
} from "../generated-attachments.js";
import { ToolInputError } from "./common.js";
import { persistGeneratedMediaBatch } from "./generated-media-batch-persistence.js";
import {
  videoGenerationTaskLifecycle,
  type VideoGenerationTaskHandle,
} from "./media-generate-background.js";
import {
  buildMediaReferenceDetails,
  buildTaskRunDetails,
  createCapabilityProviderRuntimeDeps,
  loadMediaToolReferences,
  normalizeMediaReferenceInputs,
  resolveMediaToolSandboxConfig,
} from "./media-tool-shared.js";

const GENERATED_VIDEO_MEDIA_SUBDIR = "tool-video-generation";
const GENERATED_VIDEO_PROBE_BUDGET_MS = 3000;
const GENERATED_VIDEO_PROBE_CONCURRENCY = 2;
const MAX_GENERATED_VIDEO_PROBES = 8;

export function normalizeReferenceInputs(params: {
  args: Record<string, unknown>;
  singularKey: "image" | "video" | "audioRef";
  pluralKey: "images" | "videos" | "audioRefs";
  maxCount: number;
}): string[] {
  return normalizeMediaReferenceInputs({
    args: params.args,
    singularKey: params.singularKey,
    pluralKey: params.pluralKey,
    maxCount: params.maxCount,
    label: `reference ${params.pluralKey}`,
  });
}

export function normalizeResolution(
  raw: string | undefined,
): VideoGenerationResolution | undefined {
  const normalized = raw?.trim();
  if (!normalized) {
    return undefined;
  }
  const uppercase = normalized.toUpperCase();
  if (/^\d+P$/.test(uppercase) || /^\d+K$/.test(uppercase)) {
    return uppercase;
  }
  return normalized;
}

export function normalizeAspectRatio(raw: string | undefined): string | undefined {
  const normalized = raw?.trim();
  if (!normalized) {
    return undefined;
  }
  return normalized;
}

// Extra roles cannot align to an asset; empty or non-string slots leave its role unset.
export function parseRoleArray(params: {
  raw: unknown;
  kind: "imageRoles" | "videoRoles" | "audioRoles";
  assetCount: number;
}): string[] {
  if (params.raw === undefined || params.raw === null) {
    return [];
  }
  if (!Array.isArray(params.raw)) {
    throw new ToolInputError(
      `${params.kind} must be a JSON array of role strings, parallel to the reference list.`,
    );
  }
  const roles = params.raw.map((entry) => (typeof entry === "string" ? entry.trim() : ""));
  if (roles.length > params.assetCount) {
    throw new ToolInputError(
      `${params.kind} has ${roles.length} entries but only ${params.assetCount} reference ${params.kind === "imageRoles" ? "image" : params.kind === "videoRoles" ? "video" : "audio"}${params.assetCount === 1 ? "" : "s"} were provided; extra roles cannot be aligned positionally.`,
    );
  }
  return roles;
}

function formatIgnoredVideoGenerationOverride(override: VideoGenerationIgnoredOverride): string {
  return `${sanitizeGeneratedMediaDisplayText(override.key)}=${sanitizeGeneratedMediaDisplayText(String(override.value))}`;
}

export async function loadReferenceAssets(params: {
  inputs: string[];
  expectedKind: "image" | "video" | "audio";
  maxBytes: number;
  workspaceDir?: string;
  sandboxConfig: ReturnType<typeof resolveMediaToolSandboxConfig>;
  ssrfPolicy?: SsrFPolicy;
  signal?: AbortSignal;
}): Promise<
  Array<{
    sourceAsset: VideoGenerationSourceAsset;
    resolvedInput: string;
    rewrittenFrom?: string;
  }>
> {
  const loaded = await loadMediaToolReferences<VideoGenerationSourceAsset>({
    inputs: params.inputs,
    toolName: "video_generate",
    expectedKind: params.expectedKind,
    sandbox: params.sandboxConfig,
    workspaceDir: params.workspaceDir,
    maxBytes: params.maxBytes,
    ssrfPolicy: params.ssrfPolicy,
    signal: params.signal,
    mapMedia: (media) => ({
      buffer: media.buffer,
      mimeType: "mimeType" in media ? media.mimeType : media.contentType,
      fileName: "fileName" in media ? media.fileName : undefined,
    }),
    mapRemote: (url) => ({ url }),
  });
  return loaded.map(({ source, resolvedInput, rewrittenFrom }) =>
    Object.assign({ sourceAsset: source, resolvedInput }, rewrittenFrom ? { rewrittenFrom } : {}),
  );
}

type LoadedReferenceAsset = Awaited<ReturnType<typeof loadReferenceAssets>>[number];

type ExecutedVideoGeneration = {
  provider: string;
  model: string;
  /** URLs of url-only assets that were not saved locally. */
  urlOnlyUrls: string[];
  /** Total generated video count, including url-only assets. */
  count: number;
  mediaUrls: string[];
  attachments: AgentGeneratedAttachment[];
  contentText: string;
  details: Record<string, unknown>;
  wakeResult: string;
};

function hasVideoBuffer(
  video: GeneratedVideoAsset,
): video is GeneratedVideoAsset & { buffer: Buffer } {
  return Boolean(video.buffer);
}

export async function executeVideoGenerationJob(params: {
  effectiveCfg: OpenClawConfig;
  prompt: string;
  agentDir?: string;
  model?: string;
  size?: string;
  aspectRatio?: string;
  resolution?: VideoGenerationResolution;
  durationSeconds?: number;
  audio?: boolean;
  watermark?: boolean;
  filename?: string;
  loadedReferenceImages: LoadedReferenceAsset[];
  loadedReferenceVideos: LoadedReferenceAsset[];
  loadedReferenceAudios: LoadedReferenceAsset[];
  taskHandle?: VideoGenerationTaskHandle | null;
  providerOptions?: Record<string, unknown>;
  autoProviderFallback?: boolean;
  timeoutMs?: number;
  providers?: VideoGenerationProvider[];
}): Promise<ExecutedVideoGeneration> {
  if (params.taskHandle) {
    videoGenerationTaskLifecycle.recordTaskProgress({
      handle: params.taskHandle,
      progressSummary: "Generating video",
    });
  }
  const result = await generateVideo(
    {
      cfg: params.effectiveCfg,
      prompt: params.prompt,
      agentDir: params.agentDir,
      modelOverride: params.model,
      size: params.size,
      aspectRatio: params.aspectRatio,
      resolution: params.resolution,
      durationSeconds: params.durationSeconds,
      audio: params.audio,
      watermark: params.watermark,
      inputImages: params.loadedReferenceImages.map((entry) => entry.sourceAsset),
      inputVideos: params.loadedReferenceVideos.map((entry) => entry.sourceAsset),
      inputAudios: params.loadedReferenceAudios.map((entry) => entry.sourceAsset),
      autoProviderFallback: params.autoProviderFallback,
      providerOptions: params.providerOptions,
      timeoutMs: params.timeoutMs,
    },
    createCapabilityProviderRuntimeDeps(params.providers),
  );
  if (params.taskHandle) {
    videoGenerationTaskLifecycle.recordTaskProgress({
      handle: params.taskHandle,
      progressSummary: "Saving generated video",
    });
  }

  type UrlVideo = { url: string; mimeType: string; fileName?: string };
  type PersistedVideo =
    | { kind: "saved"; media: Awaited<ReturnType<typeof saveMediaBuffer>> }
    | { kind: "url"; media: UrlVideo };
  const videoOrder: Array<PersistedVideo | number> = [];
  const bufferVideos: Array<GeneratedVideoAsset & { buffer: Buffer }> = [];
  for (const video of result.videos) {
    if (hasVideoBuffer(video)) {
      videoOrder.push(bufferVideos.length);
      bufferVideos.push(video);
      continue;
    }
    if (video.url) {
      videoOrder.push({
        kind: "url",
        media: { url: video.url, mimeType: video.mimeType, fileName: video.fileName },
      });
      continue;
    }
    throw new Error(
      `Provider ${result.provider} returned a video asset with neither buffer nor url — cannot deliver.`,
    );
  }

  const mediaMaxBytes = resolveGeneratedMediaMaxBytes(params.effectiveCfg, "video");
  const persistedVideos = await persistGeneratedMediaBatch<PersistedVideo>({
    subdir: GENERATED_VIDEO_MEDIA_SUBDIR,
    mode: "sequential",
    saves: bufferVideos.map((video) => async () => {
      try {
        const savedMedia = await saveMediaBuffer(
          video.buffer,
          video.mimeType,
          GENERATED_VIDEO_MEDIA_SUBDIR,
          mediaMaxBytes,
          params.filename || video.fileName,
        );
        return {
          value: { kind: "saved" as const, media: savedMedia },
          savedMedia,
        };
      } catch (error) {
        if (video.url && error instanceof SaveMediaSourceError && error.code === "too-large") {
          return {
            value: {
              kind: "url" as const,
              media: {
                url: video.url,
                mimeType: video.mimeType,
                fileName: video.fileName,
              },
            },
          };
        }
        throw error;
      }
    }),
  });
  // Preserve provider ordinals while replacing only buffer-backed slots with persistence results.
  const deliveredVideos = videoOrder.map((video) =>
    typeof video === "number" ? persistedVideos[video]! : video,
  );
  const requestedDurationSeconds =
    result.normalization?.durationSeconds?.requested ??
    (typeof result.metadata?.requestedDurationSeconds === "number" &&
    Number.isFinite(result.metadata.requestedDurationSeconds)
      ? result.metadata.requestedDurationSeconds
      : params.durationSeconds);
  const ignoredOverrides = result.ignoredOverrides ?? [];
  const ignoredOverrideKeys = new Set(ignoredOverrides.map((entry) => entry.key));
  const displayProvider = sanitizeGeneratedMediaDisplayText(result.provider);
  const displayModel = sanitizeGeneratedMediaDisplayText(result.model);
  const warning =
    ignoredOverrides.length > 0
      ? `Ignored unsupported overrides for ${displayProvider}/${displayModel}: ${ignoredOverrides.map(formatIgnoredVideoGenerationOverride).join(", ")}.`
      : undefined;
  const normalizedDurationSeconds =
    result.normalization?.durationSeconds?.applied ??
    (typeof result.metadata?.normalizedDurationSeconds === "number" &&
    Number.isFinite(result.metadata.normalizedDurationSeconds)
      ? result.metadata.normalizedDurationSeconds
      : requestedDurationSeconds);
  const supportedDurationSeconds =
    result.normalization?.durationSeconds?.supportedValues ??
    (Array.isArray(result.metadata?.supportedDurationSeconds)
      ? result.metadata.supportedDurationSeconds.filter(
          (entry): entry is number => typeof entry === "number" && Number.isFinite(entry),
        )
      : undefined);
  const normalizedSize =
    result.normalization?.size?.applied ??
    (typeof result.metadata?.normalizedSize === "string" && result.metadata.normalizedSize.trim()
      ? result.metadata.normalizedSize
      : undefined);
  const normalizedAspectRatio =
    result.normalization?.aspectRatio?.applied ??
    (typeof result.metadata?.normalizedAspectRatio === "string" &&
    result.metadata.normalizedAspectRatio.trim()
      ? result.metadata.normalizedAspectRatio
      : undefined);
  const normalizedResolution =
    result.normalization?.resolution?.applied ??
    (typeof result.metadata?.normalizedResolution === "string" &&
    result.metadata.normalizedResolution.trim()
      ? result.metadata.normalizedResolution
      : undefined);
  const sizeTranslatedToAspectRatio =
    result.normalization?.aspectRatio?.derivedFrom === "size" ||
    (!normalizedSize &&
      typeof result.metadata?.requestedSize === "string" &&
      result.metadata.requestedSize === params.size &&
      Boolean(normalizedAspectRatio));
  const allMediaUrls = deliveredVideos.map((video) =>
    video.kind === "saved" ? video.media.path : video.media.url,
  );
  const savedVideoMetadata = await probeMediaFilesWithinBudget(
    deliveredVideos.flatMap((video) =>
      video.kind === "saved" ? [{ filePath: video.media.path, kind: "video" as const }] : [],
    ),
    {
      budgetMs: GENERATED_VIDEO_PROBE_BUDGET_MS,
      concurrency: GENERATED_VIDEO_PROBE_CONCURRENCY,
      maxProbes: MAX_GENERATED_VIDEO_PROBES,
    },
  );
  let savedMetadataIndex = 0;
  const attachments: AgentGeneratedAttachment[] = deliveredVideos.map((video) => {
    if (video.kind === "url") {
      return {
        type: "video" as const,
        url: video.media.url,
        mimeType: video.media.mimeType,
        name: video.media.fileName,
        ...(typeof normalizedDurationSeconds === "number"
          ? { durationMs: normalizedDurationSeconds * 1000 }
          : {}),
      };
    }
    return Object.assign(
      {
        type: "video" as const,
        path: video.media.path,
        mimeType: video.media.contentType,
        name: video.media.id,
        sizeBytes: video.media.size,
        ...(typeof normalizedDurationSeconds === "number"
          ? { durationMs: normalizedDurationSeconds * 1000 }
          : {}),
      },
      savedVideoMetadata[savedMetadataIndex++] ?? {},
    );
  });
  const lines = [
    `Generated ${deliveredVideos.length} video${deliveredVideos.length === 1 ? "" : "s"} with ${displayProvider}/${displayModel}.`,
    ...(warning ? [`Warning: ${warning}`] : []),
    typeof requestedDurationSeconds === "number" &&
    typeof normalizedDurationSeconds === "number" &&
    requestedDurationSeconds !== normalizedDurationSeconds
      ? `Duration normalized: requested ${requestedDurationSeconds}s; used ${normalizedDurationSeconds}s.`
      : null,
    ...formatGeneratedAttachmentLines(attachments),
  ].filter((entry): entry is string => Boolean(entry));

  return {
    provider: result.provider,
    model: result.model,
    urlOnlyUrls: deliveredVideos.flatMap((video) =>
      video.kind === "url" ? [video.media.url] : [],
    ),
    count: deliveredVideos.length,
    mediaUrls: allMediaUrls,
    attachments,
    contentText: lines.join("\n"),
    wakeResult: lines.join("\n"),
    details: {
      provider: result.provider,
      model: result.model,
      count: deliveredVideos.length,
      media: {
        mediaUrls: allMediaUrls,
        attachments,
      },
      attachments,
      paths: allMediaUrls,
      ...buildTaskRunDetails(params.taskHandle),
      ...buildMediaReferenceDetails({
        entries: params.loadedReferenceImages,
        singleKey: "image",
        pluralKey: "images",
        getResolvedInput: (entry) => entry.resolvedInput,
      }),
      ...buildMediaReferenceDetails({
        entries: params.loadedReferenceVideos,
        singleKey: "video",
        pluralKey: "videos",
        getResolvedInput: (entry) => entry.resolvedInput,
        singleRewriteKey: "videoRewrittenFrom",
      }),
      ...(normalizedSize ||
      (!ignoredOverrideKeys.has("size") && params.size && !sizeTranslatedToAspectRatio)
        ? { size: normalizedSize ?? params.size }
        : {}),
      ...(normalizedAspectRatio || (!ignoredOverrideKeys.has("aspectRatio") && params.aspectRatio)
        ? { aspectRatio: normalizedAspectRatio ?? params.aspectRatio }
        : {}),
      ...(normalizedResolution || (!ignoredOverrideKeys.has("resolution") && params.resolution)
        ? { resolution: normalizedResolution ?? params.resolution }
        : {}),
      ...(typeof normalizedDurationSeconds === "number"
        ? { durationSeconds: normalizedDurationSeconds }
        : {}),
      ...(typeof requestedDurationSeconds === "number" &&
      typeof normalizedDurationSeconds === "number" &&
      requestedDurationSeconds !== normalizedDurationSeconds
        ? { requestedDurationSeconds }
        : {}),
      ...(supportedDurationSeconds && supportedDurationSeconds.length > 0
        ? { supportedDurationSeconds }
        : {}),
      ...(!ignoredOverrideKeys.has("audio") && typeof params.audio === "boolean"
        ? { audio: params.audio }
        : {}),
      ...(!ignoredOverrideKeys.has("watermark") && typeof params.watermark === "boolean"
        ? { watermark: params.watermark }
        : {}),
      ...(params.filename ? { filename: params.filename } : {}),
      ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
      attempts: result.attempts,
      ...(result.normalization ? { normalization: result.normalization } : {}),
      metadata: result.metadata,
      ...(warning ? { warning } : {}),
      ...(ignoredOverrides.length > 0 ? { ignoredOverrides } : {}),
    },
  };
}
