import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { saveMediaBuffer } from "../../media/store.js";
import { loadWebMedia } from "../../media/web-media.js";
import { readSnakeCaseParamRaw } from "../../param-key.js";
import { getProviderEnvVars } from "../../secrets/provider-env-vars.js";
import { resolveUserPath } from "../../utils.js";
import type { DeliveryContext } from "../../utils/delivery-context.js";
import { resolveVideoGenerationSupportedDurations } from "../../video-generation/duration-support.js";
import { parseVideoGenerationModelRef } from "../../video-generation/model-ref.js";
import {
  generateVideo,
  listRuntimeVideoGenerationProviders,
} from "../../video-generation/runtime.js";
import type {
  VideoGenerationIgnoredOverride,
  VideoGenerationProvider,
  VideoGenerationResolution,
  VideoGenerationSourceAsset,
} from "../../video-generation/types.js";
import { normalizeProviderId } from "../provider-id.js";
import {
  buildVideoGenerationTaskStatusDetails,
  buildVideoGenerationTaskStatusText,
  findActiveVideoGenerationTaskForSession,
} from "../video-generation-task-status.js";
import {
  ToolInputError,
  readNumberParam,
  readStringArrayParam,
  readStringParam,
} from "./common.js";
import { decodeDataUrl } from "./image-tool.helpers.js";
import {
  applyVideoGenerationModelConfigDefaults,
  resolveMediaToolLocalRoots,
} from "./media-tool-shared.js";
import {
  buildToolModelConfigFromCandidates,
  coerceToolModelConfig,
  hasAuthForProvider,
  hasToolModelConfig,
  resolveDefaultModelRef,
  type ToolModelConfig,
} from "./model-config.helpers.js";
import {
  createSandboxBridgeReadFile,
  resolveSandboxedBridgeMediaPath,
  type AnyAgentTool,
  type SandboxFsBridge,
  type ToolFsPolicy,
} from "./tool-runtime.helpers.js";
import {
  completeVideoGenerationTaskRun,
  createVideoGenerationTaskRun,
  failVideoGenerationTaskRun,
  recordVideoGenerationTaskProgress,
  type VideoGenerationTaskHandle,
  wakeVideoGenerationTaskCompletion,
} from "./video-generate-background.js";

const log = createSubsystemLogger("agents/tools/video-generate");
const MAX_INPUT_IMAGES = 5;
const MAX_INPUT_VIDEOS = 4;
const SUPPORTED_ASPECT_RATIOS = new Set([
  "1:1",
  "2:3",
  "3:2",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "16:9",
  "21:9",
]);

const VideoGenerateToolSchema = Type.Object({
  action: Type.Optional(
    Type.String({
      description:
        'Optional action: "generate" (default), "status" to inspect the active session task, or "list" to inspect available providers/models.',
    }),
  ),
  prompt: Type.Optional(Type.String({ description: "Video generation prompt." })),
  image: Type.Optional(
    Type.String({
      description: "Optional single reference image path or URL.",
    }),
  ),
  images: Type.Optional(
    Type.Array(Type.String(), {
      description: `Optional reference images (up to ${MAX_INPUT_IMAGES}).`,
    }),
  ),
  video: Type.Optional(
    Type.String({
      description: "Optional single reference video path or URL.",
    }),
  ),
  videos: Type.Optional(
    Type.Array(Type.String(), {
      description: `Optional reference videos (up to ${MAX_INPUT_VIDEOS}).`,
    }),
  ),
  model: Type.Optional(
    Type.String({ description: "Optional provider/model override, e.g. qwen/wan2.6-t2v." }),
  ),
  filename: Type.Optional(
    Type.String({
      description:
        "Optional output filename hint. OpenClaw preserves the basename and saves under its managed media directory.",
    }),
  ),
  size: Type.Optional(
    Type.String({
      description: "Optional size hint like 1280x720 or 1920x1080 when the provider supports it.",
    }),
  ),
  aspectRatio: Type.Optional(
    Type.String({
      description:
        "Optional aspect ratio hint: 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, or 21:9.",
    }),
  ),
  resolution: Type.Optional(
    Type.String({
      description: "Optional resolution hint: 480P, 720P, or 1080P.",
    }),
  ),
  durationSeconds: Type.Optional(
    Type.Number({
      description:
        "Optional target duration in seconds. OpenClaw may round this to the nearest provider-supported duration.",
      minimum: 1,
    }),
  ),
  audio: Type.Optional(
    Type.Boolean({
      description: "Optional audio toggle when the provider supports generated audio.",
    }),
  ),
  watermark: Type.Optional(
    Type.Boolean({
      description: "Optional watermark toggle when the provider supports it.",
    }),
  ),
});

function getVideoGenerationProviderAuthEnvVars(providerId: string): string[] {
  return getProviderEnvVars(providerId);
}

function resolveVideoGenerationModelCandidates(params: {
  cfg?: OpenClawConfig;
  agentDir?: string;
}): Array<string | undefined> {
  const providerDefaults = new Map<string, string>();
  for (const provider of listRuntimeVideoGenerationProviders({ config: params.cfg })) {
    const providerId = provider.id.trim();
    const modelId = provider.defaultModel?.trim();
    if (
      !providerId ||
      !modelId ||
      providerDefaults.has(providerId) ||
      !isVideoGenerationProviderConfigured({
        provider,
        cfg: params.cfg,
        agentDir: params.agentDir,
      })
    ) {
      continue;
    }
    providerDefaults.set(providerId, `${providerId}/${modelId}`);
  }

  const primaryProvider = resolveDefaultModelRef(params.cfg).provider;
  const orderedProviders = [
    primaryProvider,
    ...[...providerDefaults.keys()]
      .filter((providerId) => providerId !== primaryProvider)
      .toSorted(),
  ];
  const orderedRefs: string[] = [];
  const seen = new Set<string>();
  for (const providerId of orderedProviders) {
    const ref = providerDefaults.get(providerId);
    if (!ref || seen.has(ref)) {
      continue;
    }
    seen.add(ref);
    orderedRefs.push(ref);
  }
  return orderedRefs;
}

export function resolveVideoGenerationModelConfigForTool(params: {
  cfg?: OpenClawConfig;
  agentDir?: string;
}): ToolModelConfig | null {
  const explicit = coerceToolModelConfig(params.cfg?.agents?.defaults?.videoGenerationModel);
  if (hasToolModelConfig(explicit)) {
    return explicit;
  }
  return buildToolModelConfigFromCandidates({
    explicit,
    agentDir: params.agentDir,
    candidates: resolveVideoGenerationModelCandidates(params),
    isProviderConfigured: (providerId) =>
      isVideoGenerationProviderConfigured({
        providerId,
        cfg: params.cfg,
        agentDir: params.agentDir,
      }),
  });
}

function isVideoGenerationProviderConfigured(params: {
  provider?: VideoGenerationProvider;
  providerId?: string;
  cfg?: OpenClawConfig;
  agentDir?: string;
}): boolean {
  const provider =
    params.provider ??
    listRuntimeVideoGenerationProviders({ config: params.cfg }).find((candidate) => {
      const normalizedId = normalizeProviderId(params.providerId ?? "");
      return (
        normalizeProviderId(candidate.id) === normalizedId ||
        (candidate.aliases ?? []).some((alias) => normalizeProviderId(alias) === normalizedId)
      );
    });
  if (!provider) {
    return params.providerId
      ? hasAuthForProvider({ provider: params.providerId, agentDir: params.agentDir })
      : false;
  }
  if (provider.isConfigured) {
    return provider.isConfigured({
      cfg: params.cfg,
      agentDir: params.agentDir,
    });
  }
  return hasAuthForProvider({ provider: provider.id, agentDir: params.agentDir });
}

function resolveAction(args: Record<string, unknown>): "generate" | "list" | "status" {
  const raw = readStringParam(args, "action");
  if (!raw) {
    return "generate";
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "generate" || normalized === "list" || normalized === "status") {
    return normalized;
  }
  throw new ToolInputError('action must be "generate", "status", or "list"');
}

function normalizeResolution(raw: string | undefined): VideoGenerationResolution | undefined {
  const normalized = raw?.trim().toUpperCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "480P" || normalized === "720P" || normalized === "1080P") {
    return normalized;
  }
  throw new ToolInputError("resolution must be one of 480P, 720P, or 1080P");
}

function normalizeAspectRatio(raw: string | undefined): string | undefined {
  const normalized = raw?.trim();
  if (!normalized) {
    return undefined;
  }
  if (SUPPORTED_ASPECT_RATIOS.has(normalized)) {
    return normalized;
  }
  throw new ToolInputError(
    "aspectRatio must be one of 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, or 21:9",
  );
}

function readBooleanParam(params: Record<string, unknown>, key: string): boolean | undefined {
  const raw = readSnakeCaseParamRaw(params, key);
  if (typeof raw === "boolean") {
    return raw;
  }
  if (typeof raw === "string") {
    const normalized = raw.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }
  return undefined;
}

function normalizeReferenceInputs(params: {
  args: Record<string, unknown>;
  singularKey: "image" | "video";
  pluralKey: "images" | "videos";
  maxCount: number;
}): string[] {
  const single = readStringParam(params.args, params.singularKey);
  const multiple = readStringArrayParam(params.args, params.pluralKey);
  const combined = [...(single ? [single] : []), ...(multiple ?? [])];
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const candidate of combined) {
    const trimmed = candidate.trim();
    const dedupe = trimmed.startsWith("@") ? trimmed.slice(1).trim() : trimmed;
    if (!dedupe || seen.has(dedupe)) {
      continue;
    }
    seen.add(dedupe);
    deduped.push(trimmed);
  }
  if (deduped.length > params.maxCount) {
    throw new ToolInputError(
      `Too many reference ${params.pluralKey}: ${deduped.length} provided, maximum is ${params.maxCount}.`,
    );
  }
  return deduped;
}

function resolveSelectedVideoGenerationProvider(params: {
  config?: OpenClawConfig;
  videoGenerationModelConfig: ToolModelConfig;
  modelOverride?: string;
}): VideoGenerationProvider | undefined {
  const selectedRef =
    parseVideoGenerationModelRef(params.modelOverride) ??
    parseVideoGenerationModelRef(params.videoGenerationModelConfig.primary);
  if (!selectedRef) {
    return undefined;
  }
  const selectedProvider = normalizeProviderId(selectedRef.provider);
  return listRuntimeVideoGenerationProviders({ config: params.config }).find(
    (provider) =>
      normalizeProviderId(provider.id) === selectedProvider ||
      (provider.aliases ?? []).some((alias) => normalizeProviderId(alias) === selectedProvider),
  );
}

function validateVideoGenerationCapabilities(params: {
  provider: VideoGenerationProvider | undefined;
  model?: string;
  inputImageCount: number;
  inputVideoCount: number;
  size?: string;
  aspectRatio?: string;
  resolution?: VideoGenerationResolution;
  durationSeconds?: number;
  audio?: boolean;
  watermark?: boolean;
}) {
  const provider = params.provider;
  if (!provider) {
    return;
  }
  const caps = provider.capabilities;
  if (params.inputImageCount > 0) {
    const maxInputImages = caps.maxInputImages ?? MAX_INPUT_IMAGES;
    if (params.inputImageCount > maxInputImages) {
      throw new ToolInputError(
        `${provider.id} supports at most ${maxInputImages} reference image${maxInputImages === 1 ? "" : "s"}.`,
      );
    }
  }
  if (params.inputVideoCount > 0) {
    const maxInputVideos = caps.maxInputVideos ?? MAX_INPUT_VIDEOS;
    if (params.inputVideoCount > maxInputVideos) {
      throw new ToolInputError(
        `${provider.id} supports at most ${maxInputVideos} reference video${maxInputVideos === 1 ? "" : "s"}.`,
      );
    }
  }
  if (
    typeof params.durationSeconds === "number" &&
    Number.isFinite(params.durationSeconds) &&
    !resolveVideoGenerationSupportedDurations({
      provider,
      model: params.model,
    }) &&
    typeof caps.maxDurationSeconds === "number" &&
    params.durationSeconds > caps.maxDurationSeconds
  ) {
    throw new ToolInputError(
      `${provider.id} supports at most ${caps.maxDurationSeconds} seconds per video.`,
    );
  }
}

function formatIgnoredVideoGenerationOverride(override: VideoGenerationIgnoredOverride): string {
  return `${override.key}=${String(override.value)}`;
}

type VideoGenerateSandboxConfig = {
  root: string;
  bridge: SandboxFsBridge;
};

type VideoGenerateBackgroundScheduler = (work: () => Promise<void>) => void;

function defaultScheduleVideoGenerateBackgroundWork(work: () => Promise<void>) {
  queueMicrotask(() => {
    void work().catch((error) => {
      log.error("Detached video generation job crashed", {
        error,
      });
    });
  });
}

async function loadReferenceAssets(params: {
  inputs: string[];
  expectedKind: "image" | "video";
  maxBytes?: number;
  workspaceDir?: string;
  sandboxConfig: { root: string; bridge: SandboxFsBridge; workspaceOnly: boolean } | null;
}): Promise<
  Array<{
    sourceAsset: VideoGenerationSourceAsset;
    resolvedInput: string;
    rewrittenFrom?: string;
  }>
> {
  const loaded: Array<{
    sourceAsset: VideoGenerationSourceAsset;
    resolvedInput: string;
    rewrittenFrom?: string;
  }> = [];

  for (const rawInput of params.inputs) {
    const trimmed = rawInput.trim();
    const inputRaw = trimmed.startsWith("@") ? trimmed.slice(1).trim() : trimmed;
    if (!inputRaw) {
      throw new ToolInputError(`${params.expectedKind} required (empty string in array)`);
    }
    const looksLikeWindowsDrivePath = /^[a-zA-Z]:[\\/]/.test(inputRaw);
    const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(inputRaw);
    const isFileUrl = /^file:/i.test(inputRaw);
    const isHttpUrl = /^https?:\/\//i.test(inputRaw);
    const isDataUrl = /^data:/i.test(inputRaw);
    if (hasScheme && !looksLikeWindowsDrivePath && !isFileUrl && !isHttpUrl && !isDataUrl) {
      throw new ToolInputError(
        `Unsupported ${params.expectedKind} reference: ${rawInput}. Use a file path, a file:// URL, a data: URL, or an http(s) URL.`,
      );
    }
    if (params.sandboxConfig && isHttpUrl) {
      throw new ToolInputError(
        `Sandboxed video_generate does not allow remote ${params.expectedKind} URLs.`,
      );
    }

    const resolvedInput = (() => {
      if (params.sandboxConfig) {
        return inputRaw;
      }
      if (inputRaw.startsWith("~")) {
        return resolveUserPath(inputRaw);
      }
      return inputRaw;
    })();

    if (isHttpUrl && !params.sandboxConfig) {
      loaded.push({
        sourceAsset: { url: resolvedInput },
        resolvedInput,
      });
      continue;
    }

    const resolvedPathInfo: { resolved: string; rewrittenFrom?: string } = isDataUrl
      ? { resolved: "" }
      : params.sandboxConfig
        ? await resolveSandboxedBridgeMediaPath({
            sandbox: params.sandboxConfig,
            mediaPath: resolvedInput,
            inboundFallbackDir: "media/inbound",
          })
        : {
            resolved: resolvedInput.startsWith("file://")
              ? resolvedInput.slice("file://".length)
              : resolvedInput,
          };
    const resolvedPath = isDataUrl ? null : resolvedPathInfo.resolved;
    const localRoots = resolveMediaToolLocalRoots(
      params.workspaceDir,
      {
        workspaceOnly: params.sandboxConfig?.workspaceOnly === true,
      },
      resolvedPath ? [resolvedPath] : undefined,
    );
    const media = isDataUrl
      ? params.expectedKind === "image"
        ? decodeDataUrl(resolvedInput)
        : (() => {
            throw new ToolInputError("Video data: URLs are not supported for video_generate.");
          })()
      : params.sandboxConfig
        ? await loadWebMedia(resolvedPath ?? resolvedInput, {
            maxBytes: params.maxBytes,
            sandboxValidated: true,
            readFile: createSandboxBridgeReadFile({ sandbox: params.sandboxConfig }),
          })
        : await loadWebMedia(resolvedPath ?? resolvedInput, {
            maxBytes: params.maxBytes,
            localRoots,
          });
    if (media.kind !== params.expectedKind) {
      throw new ToolInputError(`Unsupported media type: ${media.kind ?? "unknown"}`);
    }
    const mimeType = "mimeType" in media ? media.mimeType : media.contentType;
    const fileName = "fileName" in media ? media.fileName : undefined;
    loaded.push({
      sourceAsset: {
        buffer: media.buffer,
        mimeType,
        fileName,
      },
      resolvedInput,
      ...(resolvedPathInfo.rewrittenFrom ? { rewrittenFrom: resolvedPathInfo.rewrittenFrom } : {}),
    });
  }

  return loaded;
}

type LoadedReferenceAsset = Awaited<ReturnType<typeof loadReferenceAssets>>[number];

type ExecutedVideoGeneration = {
  provider: string;
  model: string;
  savedPaths: string[];
  contentText: string;
  details: Record<string, unknown>;
  wakeResult: string;
};

async function executeVideoGenerationJob(params: {
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
  taskHandle?: VideoGenerationTaskHandle | null;
}): Promise<ExecutedVideoGeneration> {
  if (params.taskHandle) {
    recordVideoGenerationTaskProgress({
      handle: params.taskHandle,
      progressSummary: "Generating video",
    });
  }
  const result = await generateVideo({
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
  });
  if (params.taskHandle) {
    recordVideoGenerationTaskProgress({
      handle: params.taskHandle,
      progressSummary: "Saving generated video",
    });
  }
  const savedVideos = await Promise.all(
    result.videos.map((video) =>
      saveMediaBuffer(
        video.buffer,
        video.mimeType,
        "tool-video-generation",
        undefined,
        params.filename || video.fileName,
      ),
    ),
  );
  const requestedDurationSeconds =
    typeof result.metadata?.requestedDurationSeconds === "number" &&
    Number.isFinite(result.metadata.requestedDurationSeconds)
      ? result.metadata.requestedDurationSeconds
      : params.durationSeconds;
  const ignoredOverrides = result.ignoredOverrides ?? [];
  const ignoredOverrideKeys = new Set(ignoredOverrides.map((entry) => entry.key));
  const warning =
    ignoredOverrides.length > 0
      ? `Ignored unsupported overrides for ${result.provider}/${result.model}: ${ignoredOverrides.map(formatIgnoredVideoGenerationOverride).join(", ")}.`
      : undefined;
  const normalizedDurationSeconds =
    typeof result.metadata?.normalizedDurationSeconds === "number" &&
    Number.isFinite(result.metadata.normalizedDurationSeconds)
      ? result.metadata.normalizedDurationSeconds
      : requestedDurationSeconds;
  const supportedDurationSeconds = Array.isArray(result.metadata?.supportedDurationSeconds)
    ? result.metadata.supportedDurationSeconds.filter(
        (entry): entry is number => typeof entry === "number" && Number.isFinite(entry),
      )
    : undefined;
  const lines = [
    `Generated ${savedVideos.length} video${savedVideos.length === 1 ? "" : "s"} with ${result.provider}/${result.model}.`,
    ...(warning ? [`Warning: ${warning}`] : []),
    typeof requestedDurationSeconds === "number" &&
    typeof normalizedDurationSeconds === "number" &&
    requestedDurationSeconds !== normalizedDurationSeconds
      ? `Duration normalized: requested ${requestedDurationSeconds}s; used ${normalizedDurationSeconds}s.`
      : null,
    ...savedVideos.map((video) => `MEDIA:${video.path}`),
  ].filter((entry): entry is string => Boolean(entry));

  return {
    provider: result.provider,
    model: result.model,
    savedPaths: savedVideos.map((video) => video.path),
    contentText: lines.join("\n"),
    wakeResult: lines.join("\n"),
    details: {
      provider: result.provider,
      model: result.model,
      count: savedVideos.length,
      media: {
        mediaUrls: savedVideos.map((video) => video.path),
      },
      paths: savedVideos.map((video) => video.path),
      ...(params.taskHandle
        ? {
            task: {
              taskId: params.taskHandle.taskId,
              runId: params.taskHandle.runId,
            },
          }
        : {}),
      ...(params.loadedReferenceImages.length === 1
        ? {
            image: params.loadedReferenceImages[0]?.resolvedInput,
            ...(params.loadedReferenceImages[0]?.rewrittenFrom
              ? { rewrittenFrom: params.loadedReferenceImages[0].rewrittenFrom }
              : {}),
          }
        : params.loadedReferenceImages.length > 1
          ? {
              images: params.loadedReferenceImages.map((entry) => ({
                image: entry.resolvedInput,
                ...(entry.rewrittenFrom ? { rewrittenFrom: entry.rewrittenFrom } : {}),
              })),
            }
          : {}),
      ...(params.loadedReferenceVideos.length === 1
        ? {
            video: params.loadedReferenceVideos[0]?.resolvedInput,
            ...(params.loadedReferenceVideos[0]?.rewrittenFrom
              ? { videoRewrittenFrom: params.loadedReferenceVideos[0].rewrittenFrom }
              : {}),
          }
        : params.loadedReferenceVideos.length > 1
          ? {
              videos: params.loadedReferenceVideos.map((entry) => ({
                video: entry.resolvedInput,
                ...(entry.rewrittenFrom ? { rewrittenFrom: entry.rewrittenFrom } : {}),
              })),
            }
          : {}),
      ...(!ignoredOverrideKeys.has("size") && params.size ? { size: params.size } : {}),
      ...(!ignoredOverrideKeys.has("aspectRatio") && params.aspectRatio
        ? { aspectRatio: params.aspectRatio }
        : {}),
      ...(!ignoredOverrideKeys.has("resolution") && params.resolution
        ? { resolution: params.resolution }
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
      attempts: result.attempts,
      metadata: result.metadata,
      ...(warning ? { warning } : {}),
      ...(ignoredOverrides.length > 0 ? { ignoredOverrides } : {}),
    },
  };
}

export function createVideoGenerateTool(options?: {
  config?: OpenClawConfig;
  agentDir?: string;
  agentSessionKey?: string;
  requesterOrigin?: DeliveryContext;
  workspaceDir?: string;
  sandbox?: VideoGenerateSandboxConfig;
  fsPolicy?: ToolFsPolicy;
  scheduleBackgroundWork?: VideoGenerateBackgroundScheduler;
}): AnyAgentTool | null {
  const cfg: OpenClawConfig = options?.config ?? loadConfig();
  const videoGenerationModelConfig = resolveVideoGenerationModelConfigForTool({
    cfg,
    agentDir: options?.agentDir,
  });
  if (!videoGenerationModelConfig) {
    return null;
  }

  const sandboxConfig = options?.sandbox
    ? {
        root: options.sandbox.root,
        bridge: options.sandbox.bridge,
        workspaceOnly: options.fsPolicy?.workspaceOnly === true,
      }
    : null;
  const scheduleBackgroundWork =
    options?.scheduleBackgroundWork ?? defaultScheduleVideoGenerateBackgroundWork;

  return {
    label: "Video Generation",
    name: "video_generate",
    displaySummary: "Generate videos",
    description:
      "Generate videos using configured providers. Generated videos are saved under OpenClaw-managed media storage and delivered automatically as attachments. Duration requests may be rounded to the nearest provider-supported value.",
    parameters: VideoGenerateToolSchema,
    execute: async (_toolCallId, rawArgs) => {
      const args = rawArgs as Record<string, unknown>;
      const action = resolveAction(args);
      const effectiveCfg =
        applyVideoGenerationModelConfigDefaults(cfg, videoGenerationModelConfig) ?? cfg;

      if (action === "list") {
        const providers = listRuntimeVideoGenerationProviders({ config: effectiveCfg });
        if (providers.length === 0) {
          return {
            content: [{ type: "text", text: "No video-generation providers are registered." }],
            details: { providers: [] },
          };
        }
        const lines = providers.map((provider) => {
          const authHints = getVideoGenerationProviderAuthEnvVars(provider.id);
          const capabilities = [
            provider.capabilities.maxVideos ? `maxVideos=${provider.capabilities.maxVideos}` : null,
            provider.capabilities.maxInputImages
              ? `maxInputImages=${provider.capabilities.maxInputImages}`
              : null,
            provider.capabilities.maxInputVideos
              ? `maxInputVideos=${provider.capabilities.maxInputVideos}`
              : null,
            provider.capabilities.maxDurationSeconds
              ? `maxDurationSeconds=${provider.capabilities.maxDurationSeconds}`
              : null,
            provider.capabilities.supportedDurationSeconds?.length
              ? `supportedDurationSeconds=${provider.capabilities.supportedDurationSeconds.join("/")}`
              : null,
            provider.capabilities.supportedDurationSecondsByModel &&
            Object.keys(provider.capabilities.supportedDurationSecondsByModel).length > 0
              ? `supportedDurationSecondsByModel=${Object.entries(
                  provider.capabilities.supportedDurationSecondsByModel,
                )
                  .map(([modelId, durations]) => `${modelId}:${durations.join("/")}`)
                  .join("; ")}`
              : null,
            provider.capabilities.supportsResolution ? "resolution" : null,
            provider.capabilities.supportsAspectRatio ? "aspectRatio" : null,
            provider.capabilities.supportsSize ? "size" : null,
            provider.capabilities.supportsAudio ? "audio" : null,
            provider.capabilities.supportsWatermark ? "watermark" : null,
          ]
            .filter((entry): entry is string => Boolean(entry))
            .join(", ");
          return [
            `${provider.id}: default=${provider.defaultModel ?? "none"}`,
            provider.models?.length ? `models=${provider.models.join(", ")}` : null,
            capabilities ? `capabilities=${capabilities}` : null,
            authHints.length > 0 ? `auth=${authHints.join(" / ")}` : null,
          ]
            .filter((entry): entry is string => Boolean(entry))
            .join(" | ");
        });
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            providers: providers.map((provider) => ({
              id: provider.id,
              defaultModel: provider.defaultModel,
              models: provider.models ?? [],
              authEnvVars: getVideoGenerationProviderAuthEnvVars(provider.id),
              capabilities: provider.capabilities,
            })),
          },
        };
      }

      if (action === "status") {
        const activeTask = findActiveVideoGenerationTaskForSession(options?.agentSessionKey);
        if (!activeTask) {
          return {
            content: [
              {
                type: "text",
                text: "No active video generation task is currently running for this session.",
              },
            ],
            details: {
              action: "status",
              active: false,
            },
          };
        }
        return {
          content: [
            {
              type: "text",
              text: buildVideoGenerationTaskStatusText(activeTask),
            },
          ],
          details: {
            action: "status",
            ...buildVideoGenerationTaskStatusDetails(activeTask),
          },
        };
      }

      const activeTask = findActiveVideoGenerationTaskForSession(options?.agentSessionKey);
      if (activeTask) {
        return {
          content: [
            {
              type: "text",
              text: buildVideoGenerationTaskStatusText(activeTask, { duplicateGuard: true }),
            },
          ],
          details: {
            action: "status",
            duplicateGuard: true,
            ...buildVideoGenerationTaskStatusDetails(activeTask),
          },
        };
      }

      const prompt = readStringParam(args, "prompt", { required: true });
      const model = readStringParam(args, "model");
      const filename = readStringParam(args, "filename");
      const size = readStringParam(args, "size");
      const aspectRatio = normalizeAspectRatio(readStringParam(args, "aspectRatio"));
      const resolution = normalizeResolution(readStringParam(args, "resolution"));
      const durationSeconds = readNumberParam(args, "durationSeconds", {
        integer: true,
        strict: true,
      });
      const audio = readBooleanParam(args, "audio");
      const watermark = readBooleanParam(args, "watermark");
      const imageInputs = normalizeReferenceInputs({
        args,
        singularKey: "image",
        pluralKey: "images",
        maxCount: MAX_INPUT_IMAGES,
      });
      const videoInputs = normalizeReferenceInputs({
        args,
        singularKey: "video",
        pluralKey: "videos",
        maxCount: MAX_INPUT_VIDEOS,
      });

      const selectedProvider = resolveSelectedVideoGenerationProvider({
        config: effectiveCfg,
        videoGenerationModelConfig,
        modelOverride: model,
      });
      const loadedReferenceImages = await loadReferenceAssets({
        inputs: imageInputs,
        expectedKind: "image",
        workspaceDir: options?.workspaceDir,
        sandboxConfig,
      });
      const loadedReferenceVideos = await loadReferenceAssets({
        inputs: videoInputs,
        expectedKind: "video",
        workspaceDir: options?.workspaceDir,
        sandboxConfig,
      });
      validateVideoGenerationCapabilities({
        provider: selectedProvider,
        model:
          parseVideoGenerationModelRef(model)?.model ?? model ?? selectedProvider?.defaultModel,
        inputImageCount: loadedReferenceImages.length,
        inputVideoCount: loadedReferenceVideos.length,
        size,
        aspectRatio,
        resolution,
        durationSeconds,
        audio,
        watermark,
      });
      const taskHandle = createVideoGenerationTaskRun({
        sessionKey: options?.agentSessionKey,
        requesterOrigin: options?.requesterOrigin,
        prompt,
        providerId: selectedProvider?.id,
      });
      const shouldDetach = Boolean(taskHandle && options?.agentSessionKey?.trim());

      if (shouldDetach) {
        scheduleBackgroundWork(async () => {
          try {
            const executed = await executeVideoGenerationJob({
              effectiveCfg,
              prompt,
              agentDir: options?.agentDir,
              model,
              size,
              aspectRatio,
              resolution,
              durationSeconds,
              audio,
              watermark,
              filename,
              loadedReferenceImages,
              loadedReferenceVideos,
              taskHandle,
            });
            completeVideoGenerationTaskRun({
              handle: taskHandle,
              provider: executed.provider,
              model: executed.model,
              count: executed.savedPaths.length,
              paths: executed.savedPaths,
            });
            try {
              await wakeVideoGenerationTaskCompletion({
                handle: taskHandle,
                status: "ok",
                statusLabel: "completed successfully",
                result: executed.wakeResult,
              });
            } catch (error) {
              log.warn("Video generation completion wake failed after successful generation", {
                taskId: taskHandle?.taskId,
                runId: taskHandle?.runId,
                error,
              });
            }
          } catch (error) {
            failVideoGenerationTaskRun({
              handle: taskHandle,
              error,
            });
            await wakeVideoGenerationTaskCompletion({
              handle: taskHandle,
              status: "error",
              statusLabel: "failed",
              result: error instanceof Error ? error.message : String(error),
            });
            return;
          }
        });

        return {
          content: [
            {
              type: "text",
              text: `Background task started for video generation (${taskHandle?.taskId ?? "unknown"}). Do not call video_generate again for this request. Wait for the completion event; I'll post the finished video here when it's ready.`,
            },
          ],
          details: {
            async: true,
            status: "started",
            ...(taskHandle
              ? {
                  task: {
                    taskId: taskHandle.taskId,
                    runId: taskHandle.runId,
                  },
                }
              : {}),
            ...(loadedReferenceImages.length === 1
              ? {
                  image: loadedReferenceImages[0]?.resolvedInput,
                  ...(loadedReferenceImages[0]?.rewrittenFrom
                    ? { rewrittenFrom: loadedReferenceImages[0].rewrittenFrom }
                    : {}),
                }
              : loadedReferenceImages.length > 1
                ? {
                    images: loadedReferenceImages.map((entry) => ({
                      image: entry.resolvedInput,
                      ...(entry.rewrittenFrom ? { rewrittenFrom: entry.rewrittenFrom } : {}),
                    })),
                  }
                : {}),
            ...(loadedReferenceVideos.length === 1
              ? {
                  video: loadedReferenceVideos[0]?.resolvedInput,
                  ...(loadedReferenceVideos[0]?.rewrittenFrom
                    ? { videoRewrittenFrom: loadedReferenceVideos[0].rewrittenFrom }
                    : {}),
                }
              : loadedReferenceVideos.length > 1
                ? {
                    videos: loadedReferenceVideos.map((entry) => ({
                      video: entry.resolvedInput,
                      ...(entry.rewrittenFrom ? { rewrittenFrom: entry.rewrittenFrom } : {}),
                    })),
                  }
                : {}),
            ...(model ? { model } : {}),
            ...(size ? { size } : {}),
            ...(aspectRatio ? { aspectRatio } : {}),
            ...(resolution ? { resolution } : {}),
            ...(typeof durationSeconds === "number" ? { durationSeconds } : {}),
            ...(typeof audio === "boolean" ? { audio } : {}),
            ...(typeof watermark === "boolean" ? { watermark } : {}),
            ...(filename ? { filename } : {}),
          },
        };
      }

      try {
        const executed = await executeVideoGenerationJob({
          effectiveCfg,
          prompt,
          agentDir: options?.agentDir,
          model,
          size,
          aspectRatio,
          resolution,
          durationSeconds,
          audio,
          watermark,
          filename,
          loadedReferenceImages,
          loadedReferenceVideos,
          taskHandle,
        });
        completeVideoGenerationTaskRun({
          handle: taskHandle,
          provider: executed.provider,
          model: executed.model,
          count: executed.savedPaths.length,
          paths: executed.savedPaths,
        });

        return {
          content: [{ type: "text", text: executed.contentText }],
          details: executed.details,
        };
      } catch (error) {
        failVideoGenerationTaskRun({
          handle: taskHandle,
          error,
        });
        throw error;
      }
    },
  };
}
