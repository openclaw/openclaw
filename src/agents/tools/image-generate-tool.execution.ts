/** Owns the exact provider view through image generation and media persistence. */
import type { GenerateImageParams } from "../../image-generation/runtime-types.js";
import { generateImage } from "../../image-generation/runtime.js";
import type {
  ImageGenerationProvider,
  ImageGenerationResolution,
  ImageGenerationSourceImage,
} from "../../image-generation/types.js";
import { resolveGeneratedMediaMaxBytes } from "../../media/configured-max-bytes.js";
import { getImageMetadata } from "../../media/media-services.js";
import { extractOriginalFilename } from "../../media/store.js";
import { formatGeneratedAttachmentLines } from "../generated-attachments.js";
import { ToolInputError } from "./common.js";
import { persistGeneratedMediaBuffers } from "./generated-media-batch-persistence.js";
import type { MediaGenerationTaskHandle } from "./media-generate-background-shared.js";
import { imageGenerationTaskLifecycle } from "./media-generate-background.js";
import {
  buildMediaGenerateToolExecutionResult,
  describeMediaGenerationResult,
  buildMediaGenerationGeometryDetails,
} from "./media-generate-result-shared.js";
import {
  buildMediaReferenceDetails,
  createCapabilityProviderRuntimeDeps,
  type LoadedMediaToolReference,
} from "./media-tool-shared.js";

const DEFAULT_RESOLUTION: ImageGenerationResolution = "1K";
const GENERATED_IMAGE_MEDIA_SUBDIR = "tool-image-generation";

export async function executeImageGenerationJob(params: {
  request: Omit<GenerateImageParams, "authStore">;
  filename?: string;
  loadedReferenceImages: LoadedMediaToolReference<ImageGenerationSourceImage>[];
  taskHandle: MediaGenerationTaskHandle | null;
  providers: ImageGenerationProvider[];
}) {
  const { request } = params;
  imageGenerationTaskLifecycle.recordTaskProgress({
    handle: params.taskHandle,
    progressSummary: "Generating image",
  });
  const result = await generateImage(
    request,
    createCapabilityProviderRuntimeDeps(params.providers),
  );
  imageGenerationTaskLifecycle.recordTaskProgress({
    handle: params.taskHandle,
    progressSummary: "Saving generated image",
  });
  const { displayProvider, displayModel, warning } = describeMediaGenerationResult(result);
  const geometryDetails = buildMediaGenerationGeometryDetails("image", result, {
    size: request.size,
    aspectRatio: request.aspectRatio,
  });

  const savedImages = await persistGeneratedMediaBuffers({
    assets: result.images,
    subdir: GENERATED_IMAGE_MEDIA_SUBDIR,
    maxBytes: resolveGeneratedMediaMaxBytes(request.cfg, "image"),
    filename: params.filename,
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
      ...buildMediaReferenceDetails(params.loadedReferenceImages, "image"),
      ...geometryDetails,
      ...(request.quality ? { quality: request.quality } : {}),
      ...(request.outputFormat ? { outputFormat: request.outputFormat } : {}),
      ...(request.background ? { background: request.background } : {}),
      ...(params.filename ? { filename: params.filename } : {}),
      ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
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
