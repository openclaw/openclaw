import { extnameFromAnyPath } from "@openclaw/media-core/file-name";
import { extensionForMime } from "@openclaw/media-core/mime";
/** Owns the exact provider view through image generation and media persistence. */
import type { GenerateImageParams } from "../../image-generation/runtime-types.js";
import { generateImage } from "../../image-generation/runtime.js";
import type {
  ImageGenerationProvider,
  ImageGenerationResolution,
  ImageGenerationSourceImage,
} from "../../image-generation/types.js";
import { resolveGeneratedMediaMaxBytes } from "../../media/configured-max-bytes.js";
import { encodeImageWithinBytes, getImageMetadata } from "../../media/media-services.js";
import { formatMediaSize } from "../../media/store.shared.js";
import { persistGeneratedMediaBuffers } from "./generated-media-batch-persistence.js";
import type { MediaGenerationTaskHandle } from "./media-generate-background-shared.js";
import { imageGenerationTaskLifecycle } from "./media-generate-background.js";
import {
  buildMediaGenerateToolExecutionResult,
  buildSavedMediaAttachment,
  buildMediaGenerationGeometryDetails,
  type AcquireGeneratedMediaSandbox,
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
  sandbox?: AcquireGeneratedMediaSandbox;
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
  const geometryDetails = buildMediaGenerationGeometryDetails("image", result, {
    size: request.size,
    aspectRatio: request.aspectRatio,
  });

  const maxBytes = resolveGeneratedMediaMaxBytes(request.cfg, "image");
  const fitted = await fitGeneratedImagesToMaxBytes(
    result.images.map((image) => ({ ...image, fileName: params.filename || image.fileName })),
    maxBytes,
  );
  const savedImages = await persistGeneratedMediaBuffers({
    assets: fitted.images,
    subdir: GENERATED_IMAGE_MEDIA_SUBDIR,
    maxBytes,
  });

  const revisedPrompts = result.images
    .map((image) => image.revisedPrompt?.trim())
    .filter((entry): entry is string => Boolean(entry));
  const attachments = savedImages.map((image) => buildSavedMediaAttachment("image", image));
  const execution = await buildMediaGenerateToolExecutionResult({
    kind: "image",
    result,
    attachments,
    mediaUrls: savedImages.map((media) => media.path),
    sandbox: params.sandbox,
    maxBytes,
    messages: fitted.messages,
    taskHandle: params.taskHandle,
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

/**
 * Re-encodes provider images that exceed the media store cap so a paid generation is kept.
 * Fails only when no encoding fits, naming the generated image, its size and the cap.
 */
async function fitGeneratedImagesToMaxBytes<
  T extends { buffer: Buffer; mimeType: string; fileName?: string },
>(images: readonly T[], maxBytes: number): Promise<{ images: T[]; messages: string[] }> {
  const fitted: T[] = [];
  const messages: string[] = [];
  const limit = formatMediaSize(maxBytes);
  for (const [index, image] of images.entries()) {
    if (image.buffer.byteLength <= maxBytes) {
      fitted.push(image);
      continue;
    }
    const label = `Generated image ${index + 1} (${image.mimeType}, ${formatMediaSize(image.buffer.byteLength)})`;
    let encoded: Awaited<ReturnType<typeof encodeImageWithinBytes>>;
    try {
      encoded = await encodeImageWithinBytes(image.buffer, maxBytes);
    } catch (error) {
      throw new Error(`${label} exceeds the ${limit} media limit and could not be re-encoded`, {
        cause: error,
      });
    }
    if (encoded.bytes > maxBytes) {
      throw new Error(
        `${label} exceeds the ${limit} media limit; the smallest re-encoding is ${formatMediaSize(encoded.bytes)} (${encoded.mimeType}, ${encoded.width}x${encoded.height})`,
      );
    }
    const fileName =
      image.fileName &&
      `${image.fileName.slice(0, image.fileName.length - extnameFromAnyPath(image.fileName).length)}${extensionForMime(encoded.mimeType) ?? ""}`;
    fitted.push({
      ...image,
      buffer: encoded.data,
      mimeType: encoded.mimeType,
      ...(fileName ? { fileName } : {}),
    });
    messages.push(
      `${label} exceeded the ${limit} media limit; saved as ${encoded.mimeType}, ${formatMediaSize(encoded.bytes)}, ${encoded.width}x${encoded.height}.`,
    );
  }
  return { images: fitted, messages };
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
