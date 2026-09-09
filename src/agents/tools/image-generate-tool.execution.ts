/** Owns the exact provider view through image generation and media persistence. */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { generateImage } from "../../image-generation/runtime.js";
import type {
  ImageGenerationIgnoredOverride,
  ImageGenerationBackground,
  ImageGenerationOutputFormat,
  ImageGenerationProvider,
  ImageGenerationProviderOptions,
  ImageGenerationQuality,
  ImageGenerationResolution,
  ImageGenerationSourceImage,
} from "../../image-generation/types.js";
import type { SsrFPolicy } from "../../infra/net/ssrf.js";
import { resolveGeneratedMediaMaxBytes } from "../../media/configured-max-bytes.js";
import { getImageMetadata } from "../../media/media-services.js";
import { saveMediaBuffer } from "../../media/store.js";
import { acquirePluginCapabilityProviders } from "../../plugins/capability-provider-acquisition.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import {
  formatGeneratedAttachmentLines,
  sanitizeGeneratedMediaDisplayText,
  type AgentGeneratedAttachment,
} from "../generated-attachments.js";
import type { PreparedModelRuntimeSnapshot } from "../prepared-model-runtime.types.js";
import { ToolInputError } from "./common.js";
import { persistGeneratedMediaBatch } from "./generated-media-batch-persistence.js";
import {
  imageGenerationTaskLifecycle,
  type ImageGenerationTaskHandle,
} from "./media-generate-background.js";
import {
  buildMediaReferenceDetails,
  buildTaskRunDetails,
  createCapabilityProviderRuntimeDeps,
  loadMediaToolReferences,
  resolveMediaToolSandboxConfig,
} from "./media-tool-shared.js";

const DEFAULT_RESOLUTION: ImageGenerationResolution = "1K";
const GENERATED_IMAGE_MEDIA_SUBDIR = "tool-image-generation";

export async function acquireImageGenerationToolProviders(params: {
  cfg: OpenClawConfig;
  prepared?: PreparedModelRuntimeSnapshot;
}) {
  const work = new AsyncWorkScope();
  const prepared = params.prepared;
  const inGeneration = <T>(run: () => T): T =>
    prepared
      ? withPluginRuntimeGenerationScope(
          { metadataSnapshot: prepared.metadataSnapshot, pluginRegistry: prepared.pluginRegistry },
          run,
        )
      : run();
  let captured:
    | ReturnType<NonNullable<PreparedModelRuntimeSnapshot["acquireMediaCapabilityProviders"]>>
    | undefined;
  let cold:
    | Awaited<ReturnType<typeof acquirePluginCapabilityProviders<"imageGenerationProviders">>>
    | undefined;
  let releaseCompletion: Promise<void> | undefined;
  const release = () =>
    (releaseCompletion ??= Promise.resolve().then(async () => {
      work.beginClose();
      try {
        await work.runWhenIdle(async () => {
          const errors: unknown[] = [];
          // A copied prepared registry can contribute callbacks without a second physical claim.
          // Drain the cold view's work before surrendering its original prepared source.
          for (const owner of [cold, captured]) {
            try {
              await owner?.release();
            } catch (error) {
              errors.push(error);
            }
          }
          if (errors.length > 0) {
            throw new AggregateError(errors, "Image provider resource cleanup failed");
          }
        });
      } finally {
        await work.drain();
      }
    }));
  try {
    const providers = await work.track(async () => {
      captured = prepared?.acquireMediaCapabilityProviders?.();
      const known = captured
        ? captured.providers.imageGenerationProviders
        : prepared?.mediaCapabilityProviders?.imageGenerationProviders;
      if (known !== undefined) {
        return [...known];
      }
      cold = await inGeneration(() =>
        acquirePluginCapabilityProviders({ key: "imageGenerationProviders", cfg: params.cfg }),
      );
      return cold.providers;
    });
    return {
      providers,
      assertOpen: () => {
        if (releaseCompletion) {
          throw new Error("Image provider resources have been released");
        }
        captured?.assertOpen();
        cold?.assertOpen();
      },
      run: <T>(run: () => T | Promise<T>) =>
        releaseCompletion
          ? Promise.reject(new Error("Image provider resources have been released"))
          : work.track(() => inGeneration(() => (cold ? cold.run(run) : run()))),
      release,
    };
  } catch (error) {
    let cleanupFailure: { error: unknown } | undefined;
    try {
      await release();
    } catch (cleanupError) {
      cleanupFailure = { error: cleanupError };
    }
    if (cleanupFailure) {
      throw new AggregateError(
        [error, cleanupFailure.error],
        "Image provider acquisition and cleanup failed",
        {
          cause: error,
        },
      );
    }
    throw error;
  }
}

function formatIgnoredImageGenerationOverride(override: ImageGenerationIgnoredOverride): string {
  return `${sanitizeGeneratedMediaDisplayText(override.key)}=${sanitizeGeneratedMediaDisplayText(override.value)}`;
}

type ExecutedImageGeneration = {
  provider: string;
  model: string;
  count: number;
  attachments: AgentGeneratedAttachment[];
  contentText: string;
  details: Record<string, unknown>;
  wakeResult: string;
};

export async function executeImageGenerationJob(params: {
  effectiveCfg: OpenClawConfig;
  prompt: string;
  agentDir?: string;
  model?: string;
  size?: string;
  aspectRatio?: string;
  resolution?: ImageGenerationResolution;
  inferredResolution?: ImageGenerationResolution;
  quality?: ImageGenerationQuality;
  outputFormat?: ImageGenerationOutputFormat;
  background?: ImageGenerationBackground;
  count: number;
  inputImages: ImageGenerationSourceImage[];
  timeoutMs?: number;
  providerOptions?: ImageGenerationProviderOptions;
  ssrfPolicy?: SsrFPolicy;
  filename?: string;
  loadedReferenceImages: Array<{ resolvedImage: string; rewrittenFrom?: string }>;
  taskHandle?: ImageGenerationTaskHandle | null;
  autoProviderFallback?: boolean;
  providers: ImageGenerationProvider[];
}) {
  if (params.taskHandle) {
    imageGenerationTaskLifecycle.recordTaskProgress({
      handle: params.taskHandle,
      progressSummary: "Generating image",
    });
  }
  const result = await generateImage(
    {
      cfg: params.effectiveCfg,
      prompt: params.prompt,
      agentDir: params.agentDir,
      modelOverride: params.model,
      autoProviderFallback: params.autoProviderFallback,
      size: params.size,
      aspectRatio: params.aspectRatio,
      resolution: params.resolution,
      inferredResolution: params.inferredResolution,
      quality: params.quality,
      outputFormat: params.outputFormat,
      background: params.background,
      count: params.count,
      inputImages: params.inputImages,
      timeoutMs: params.timeoutMs,
      providerOptions: params.providerOptions,
      ssrfPolicy: params.ssrfPolicy,
    },
    createCapabilityProviderRuntimeDeps(params.providers),
  );
  if (params.taskHandle) {
    imageGenerationTaskLifecycle.recordTaskProgress({
      handle: params.taskHandle,
      progressSummary: "Saving generated image",
    });
  }
  const ignoredOverrides = result.ignoredOverrides ?? [];
  const displayProvider = sanitizeGeneratedMediaDisplayText(result.provider);
  const displayModel = sanitizeGeneratedMediaDisplayText(result.model);
  const warning =
    ignoredOverrides.length > 0
      ? `Ignored unsupported overrides for ${displayProvider}/${displayModel}: ${ignoredOverrides.map(formatIgnoredImageGenerationOverride).join(", ")}.`
      : undefined;
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
  const appliedResolution = result.appliedResolution ?? normalizedResolution;
  const sizeTranslatedToAspectRatio =
    result.normalization?.aspectRatio?.derivedFrom === "size" ||
    (!normalizedSize &&
      typeof result.metadata?.requestedSize === "string" &&
      result.metadata.requestedSize === params.size &&
      Boolean(normalizedAspectRatio));

  const mediaMaxBytes = resolveGeneratedMediaMaxBytes(params.effectiveCfg, "image");
  const savedImages = await persistGeneratedMediaBatch({
    subdir: GENERATED_IMAGE_MEDIA_SUBDIR,
    mode: "concurrent",
    saves: result.images.map((image) => async () => {
      const savedMedia = await saveMediaBuffer(
        image.buffer,
        image.mimeType,
        GENERATED_IMAGE_MEDIA_SUBDIR,
        mediaMaxBytes,
        params.filename || image.fileName,
      );
      return { value: savedMedia, savedMedia };
    }),
  });

  const revisedPrompts = result.images
    .map((image) => image.revisedPrompt?.trim())
    .filter((entry): entry is string => Boolean(entry));
  const attachments = savedImages.map((image) => ({
    type: "image" as const,
    path: image.path,
    mimeType: image.contentType,
    name: image.id,
    sizeBytes: image.size,
  }));
  const lines = [
    `Generated ${savedImages.length} image${savedImages.length === 1 ? "" : "s"} with ${displayProvider}/${displayModel}.`,
    ...(warning ? [`Warning: ${warning}`] : []),
    ...formatGeneratedAttachmentLines(attachments),
  ];
  return {
    provider: result.provider,
    model: result.model,
    count: savedImages.length,
    attachments,
    contentText: lines.join("\n"),
    wakeResult: lines.join("\n"),
    details: {
      provider: result.provider,
      model: result.model,
      count: savedImages.length,
      media: {
        mediaUrls: savedImages.map((image) => image.path),
        attachments,
      },
      attachments,
      paths: savedImages.map((image) => image.path),
      ...buildTaskRunDetails(params.taskHandle),
      ...buildMediaReferenceDetails({
        entries: params.loadedReferenceImages,
        singleKey: "image",
        pluralKey: "images",
        getResolvedInput: (entry) => entry.resolvedImage,
      }),
      ...(appliedResolution ? { resolution: appliedResolution } : {}),
      ...(normalizedSize || (params.size && !sizeTranslatedToAspectRatio)
        ? { size: normalizedSize ?? params.size }
        : {}),
      ...(normalizedAspectRatio || params.aspectRatio
        ? { aspectRatio: normalizedAspectRatio ?? params.aspectRatio }
        : {}),
      ...(params.quality ? { quality: params.quality } : {}),
      ...(params.outputFormat ? { outputFormat: params.outputFormat } : {}),
      ...(params.background ? { background: params.background } : {}),
      ...(params.filename ? { filename: params.filename } : {}),
      ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
      attempts: result.attempts,
      ...(result.normalization ? { normalization: result.normalization } : {}),
      metadata: result.metadata,
      ...(warning ? { warning } : {}),
      ...(ignoredOverrides.length > 0 ? { ignoredOverrides } : {}),
      ...(revisedPrompts.length > 0 ? { revisedPrompts } : {}),
    },
  } satisfies ExecutedImageGeneration;
}

export async function loadImageGenerationReferences(params: {
  imageInputs: string[];
  maxBytes: number;
  workspaceDir?: string;
  sandboxConfig: ReturnType<typeof resolveMediaToolSandboxConfig>;
  ssrfPolicy?: SsrFPolicy;
  signal?: AbortSignal;
}): Promise<
  Array<{
    sourceImage: ImageGenerationSourceImage;
    resolvedImage: string;
    rewrittenFrom?: string;
  }>
> {
  const loaded = await loadMediaToolReferences<ImageGenerationSourceImage>({
    inputs: params.imageInputs,
    toolName: "image_generate",
    expectedKind: "image",
    sandbox: params.sandboxConfig,
    workspaceDir: params.workspaceDir,
    maxBytes: params.maxBytes,
    ssrfPolicy: params.ssrfPolicy,
    signal: params.signal,
    mapMedia: (media) => ({
      buffer: media.buffer,
      mimeType:
        ("contentType" in media && media.contentType) ||
        ("mimeType" in media && media.mimeType) ||
        "image/png",
    }),
  });
  return loaded.map(({ source, resolvedInput, rewrittenFrom }) =>
    Object.assign(
      { sourceImage: source, resolvedImage: resolvedInput },
      rewrittenFrom ? { rewrittenFrom } : {},
    ),
  );
}

export async function inferImageGenerationResolution(
  images: ImageGenerationSourceImage[],
  signal?: AbortSignal,
): Promise<ImageGenerationResolution> {
  let maxDimension = 0;
  for (const image of images) {
    signal?.throwIfAborted();
    const meta = await getImageMetadata(image.buffer);
    signal?.throwIfAborted();
    const dimension = Math.max(meta?.width ?? 0, meta?.height ?? 0);
    maxDimension = Math.max(maxDimension, dimension);
  }
  if (maxDimension >= 3000) {
    return "4K";
  }
  if (maxDimension >= 1500) {
    return "2K";
  }
  return DEFAULT_RESOLUTION;
}

const SUPPORTED_ASPECT_RATIOS = new Set([
  "1:1",
  "2:1",
  "20:9",
  "19.5:9",
  "2:3",
  "3:2",
  "2.35:1",
  "3:4",
  "4:3",
  "4:5",
  "5:4",
  "9:16",
  "9:19.5",
  "9:20",
  "16:9",
  "21:9",
  "1:2",
  "4:1",
  "1:4",
  "8:1",
  "1:8",
]);

export function normalizeImageGenerationAspectRatio(raw: string | undefined): string | undefined {
  const normalized = raw?.trim();
  if (!normalized) {
    return undefined;
  }
  if (SUPPORTED_ASPECT_RATIOS.has(normalized)) {
    return normalized;
  }
  throw new ToolInputError(
    "aspectRatio must be one of 1:1, 2:1, 20:9, 19.5:9, 2:3, 3:2, 2.35:1, 3:4, 4:3, 4:5, 5:4, 9:16, 9:19.5, 9:20, 16:9, 21:9, 1:2, 4:1, 1:4, 8:1, or 1:8",
  );
}

export function normalizeImageGenerationResolution(
  raw: string | undefined,
): ImageGenerationResolution | undefined {
  const normalized = raw?.trim().toUpperCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "1K" || normalized === "2K" || normalized === "4K") {
    return normalized;
  }
  throw new ToolInputError("resolution must be one of 1K, 2K, or 4K");
}
