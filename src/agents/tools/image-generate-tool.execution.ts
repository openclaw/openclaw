/** Owns the exact provider view through image generation and media persistence. */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { generateImage } from "../../image-generation/runtime.js";
import type {
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
import { extractOriginalFilename, saveMediaBuffer } from "../../media/store.js";
import { formatGeneratedAttachmentLines } from "../generated-attachments.js";
import { ToolInputError } from "./common.js";
import { persistGeneratedMediaBatch } from "./generated-media-batch-persistence.js";
import {
  imageGenerationTaskLifecycle,
  type ImageGenerationTaskHandle,
} from "./media-generate-background.js";
import {
  buildMediaGenerateToolExecutionResult,
  describeMediaGenerationResult,
  resolveMediaGenerationResultGeometry,
} from "./media-generate-result-shared.js";
import {
  buildMediaReferenceDetails,
  createCapabilityProviderRuntimeDeps,
  type LoadedMediaToolReference,
} from "./media-tool-shared.js";

const DEFAULT_RESOLUTION: ImageGenerationResolution = "1K";
const GENERATED_IMAGE_MEDIA_SUBDIR = "tool-image-generation";

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
  loadedReferenceImages: LoadedMediaToolReference<ImageGenerationSourceImage>[];
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
  const { displayProvider, displayModel, warning } = describeMediaGenerationResult(result);
  const {
    normalizedSize,
    normalizedAspectRatio,
    normalizedResolution,
    sizeTranslatedToAspectRatio,
  } = resolveMediaGenerationResultGeometry(result, params.size);
  const appliedResolution = result.appliedResolution ?? normalizedResolution;

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
    name: extractOriginalFilename(image.path),
    sizeBytes: image.size,
  }));
  const lines = [
    `Generated ${savedImages.length} image${savedImages.length === 1 ? "" : "s"} with ${displayProvider}/${displayModel}.`,
    ...(warning ? [`Warning: ${warning}`] : []),
    ...formatGeneratedAttachmentLines(attachments),
  ];
  const execution = buildMediaGenerateToolExecutionResult({
    result,
    attachments,
    mediaUrls: savedImages.map((media) => media.path),
    lines,
    taskHandle: params.taskHandle,
    warning,
    details: {
      ...buildMediaReferenceDetails({
        entries: params.loadedReferenceImages,
        singleKey: "image",
        pluralKey: "images",
        getResolvedInput: (entry) => entry.resolvedInput,
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
    },
  });
  if (revisedPrompts.length > 0) {
    execution.details.revisedPrompts = revisedPrompts;
  }
  return execution;
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
