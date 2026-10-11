/** Completes video reference loading, generation, and ordered media persistence. */
import type { SsrFPolicy } from "../../infra/net/ssrf.js";
import { resolveGeneratedMediaMaxBytes } from "../../media/configured-max-bytes.js";
import { probeMediaFilesWithinBudget } from "../../media/media-probe.js";
import { saveMediaBuffer } from "../../media/store.js";
import { SaveMediaSourceError } from "../../media/store.shared.js";
import type { GenerateVideoParams } from "../../video-generation/runtime-types.js";
import { generateVideo } from "../../video-generation/runtime.js";
import type {
  GeneratedVideoAsset,
  VideoGenerationProvider,
  VideoGenerationResolution,
  VideoGenerationSourceAsset,
} from "../../video-generation/types.js";
import type { AgentGeneratedAttachment } from "../generated-attachments.js";
import type { ToolFsPolicy } from "../tool-fs-policy.js";
import type { AgentWorkspaceReadiness } from "../workspace-readiness.js";
import { persistGeneratedMediaBatch } from "./generated-media-batch-persistence.js";
import type { MediaGenerationTaskHandle } from "./media-generate-background-shared.js";
import { videoGenerationTaskLifecycle } from "./media-generate-background.js";
import {
  buildMediaGenerateToolExecutionResult,
  buildMediaGenerationDurationDetails,
  buildMediaGenerationGeometryDetails,
  buildSavedMediaAttachment,
  type MediaGenerateToolExecutionResult,
} from "./media-generate-result-shared.js";
import {
  buildMediaReferenceDetails,
  createCapabilityProviderRuntimeDeps,
  loadMediaToolReferences,
  resolveMediaToolSandboxConfig,
  type LoadedMediaToolReference,
} from "./media-tool-shared.js";

const GENERATED_VIDEO_MEDIA_SUBDIR = "tool-video-generation";
const GENERATED_VIDEO_PROBE_BUDGET_MS = 3000;
const GENERATED_VIDEO_PROBE_CONCURRENCY = 2;
const MAX_GENERATED_VIDEO_PROBES = 8;

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

export async function loadReferenceAssets(params: {
  workspaceReadiness?: AgentWorkspaceReadiness;
  inputs: string[];
  roles: string[];
  expectedKind: "image" | "video" | "audio";
  maxBytes: number;
  workspaceDir?: string;
  cwd?: string;
  fsPolicy?: ToolFsPolicy;
  sandboxConfig: ReturnType<typeof resolveMediaToolSandboxConfig>;
  ssrfPolicy?: SsrFPolicy;
  signal?: AbortSignal;
}): Promise<LoadedMediaToolReference<VideoGenerationSourceAsset>[]> {
  const loaded = await loadMediaToolReferences<VideoGenerationSourceAsset>({
    ...params,
    toolName: "video_generate",
    sandbox: params.sandboxConfig,
    mapMedia: (media) => ({
      buffer: media.buffer,
      mimeType: "mimeType" in media ? media.mimeType : media.contentType,
      fileName: "fileName" in media ? media.fileName : undefined,
    }),
    mapRemote: (url) => ({ url }),
  });
  for (const [index, { source }] of loaded.entries()) {
    const role = params.roles[index];
    if (role) {
      source.role = role;
    }
  }
  return loaded;
}

type LoadedReferenceAsset = Awaited<ReturnType<typeof loadReferenceAssets>>[number];

type ExecutedVideoGeneration = MediaGenerateToolExecutionResult & {
  mediaUrls: string[];
};

export async function executeVideoGenerationJob(params: {
  request: Omit<GenerateVideoParams, "authStore">;
  filename?: string;
  loadedReferenceImages: LoadedReferenceAsset[];
  loadedReferenceVideos: LoadedReferenceAsset[];
  taskHandle: MediaGenerationTaskHandle | null;
  providers?: VideoGenerationProvider[];
}): Promise<ExecutedVideoGeneration> {
  const { request } = params;
  videoGenerationTaskLifecycle.recordTaskProgress({
    handle: params.taskHandle,
    progressSummary: "Generating video",
  });
  const result = await generateVideo(
    request,
    createCapabilityProviderRuntimeDeps(params.providers),
  );
  videoGenerationTaskLifecycle.recordTaskProgress({
    handle: params.taskHandle,
    progressSummary: "Saving generated video",
  });

  const remoteAttachment = (url: string, video: GeneratedVideoAsset) => ({
    type: "video" as const,
    url,
    mimeType: video.mimeType,
    name: video.fileName,
  });
  type PersistedVideo =
    | ReturnType<typeof buildSavedMediaAttachment<"video">>
    | ReturnType<typeof remoteAttachment>;
  // Validate the entire batch before any save starts, retaining provider order.
  const saves = Array.from(result.videos, (video) => {
    const buffer = video.buffer;
    if (!buffer) {
      if (!video.url) {
        throw new Error(
          `Provider ${result.provider} returned a video asset with neither buffer nor url — cannot deliver.`,
        );
      }
      const value = remoteAttachment(video.url, video);
      return async () => ({ value });
    }
    return async () => {
      try {
        const savedMedia = await saveMediaBuffer(
          buffer,
          video.mimeType,
          GENERATED_VIDEO_MEDIA_SUBDIR,
          mediaMaxBytes,
          params.filename || video.fileName,
        );
        return {
          value: buildSavedMediaAttachment("video", savedMedia),
          savedMedia,
        };
      } catch (error) {
        if (video.url && error instanceof SaveMediaSourceError && error.code === "too-large") {
          return { value: remoteAttachment(video.url, video) };
        }
        throw error;
      }
    };
  });
  const mediaMaxBytes = resolveGeneratedMediaMaxBytes(request.cfg, "video");
  const deliveredVideos = await persistGeneratedMediaBatch<PersistedVideo>({
    subdir: GENERATED_VIDEO_MEDIA_SUBDIR,
    mode: "sequential",
    saves,
  });
  const ignoredOverrides = result.ignoredOverrides ?? [];
  const ignoredOverrideKeys = new Set(ignoredOverrides.map((entry) => entry.key));
  const duration = buildMediaGenerationDurationDetails(
    "video",
    result,
    request.durationSeconds,
    ignoredOverrideKeys,
  );
  const supportedDurationSeconds =
    result.normalization?.durationSeconds?.supportedValues ??
    (Array.isArray(result.metadata?.supportedDurationSeconds)
      ? result.metadata.supportedDurationSeconds.filter(
          (entry): entry is number => typeof entry === "number" && Number.isFinite(entry),
        )
      : undefined);
  const geometryDetails = buildMediaGenerationGeometryDetails(
    "video",
    result,
    request,
    ignoredOverrideKeys,
  );
  const allMediaUrls = deliveredVideos.map((video) => ("path" in video ? video.path : video.url));
  const savedVideoMetadata = await probeMediaFilesWithinBudget(
    deliveredVideos.flatMap((video) =>
      "path" in video ? [{ filePath: video.path, kind: "video" as const }] : [],
    ),
    {
      budgetMs: GENERATED_VIDEO_PROBE_BUDGET_MS,
      concurrency: GENERATED_VIDEO_PROBE_CONCURRENCY,
      maxProbes: MAX_GENERATED_VIDEO_PROBES,
    },
  );
  let savedMetadataIndex = 0;
  const attachments: AgentGeneratedAttachment[] = deliveredVideos.map((video) =>
    Object.assign(
      {
        ...video,
        ...(typeof duration.applied === "number" ? { durationMs: duration.applied * 1000 } : {}),
      },
      "path" in video ? (savedVideoMetadata[savedMetadataIndex++] ?? {}) : {},
    ),
  );

  const executionResult = buildMediaGenerateToolExecutionResult({
    kind: "video",
    result,
    attachments,
    mediaUrls: allMediaUrls,
    messages: [duration.message],
    taskHandle: params.taskHandle,
    details: {
      ...buildMediaReferenceDetails(params.loadedReferenceImages, "image"),
      ...buildMediaReferenceDetails(params.loadedReferenceVideos, "video", {
        singleRewriteKey: "videoRewrittenFrom",
      }),
      ...geometryDetails,
      ...duration.details,
      ...(supportedDurationSeconds && supportedDurationSeconds.length > 0
        ? { supportedDurationSeconds }
        : {}),
      ...(!ignoredOverrideKeys.has("audio") && typeof request.audio === "boolean"
        ? { audio: request.audio }
        : {}),
      ...(!ignoredOverrideKeys.has("watermark") && typeof request.watermark === "boolean"
        ? { watermark: request.watermark }
        : {}),
      ...(params.filename ? { filename: params.filename } : {}),
      ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
    },
  });
  return {
    ...executionResult,
    mediaUrls: allMediaUrls,
  };
}
