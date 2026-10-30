// Image input normalization converts AVIF/HEIC/HEIF payloads through the shared
// input-file media path before provider execution.
import { mimeTypeFromFilePath, normalizeMimeType } from "@openclaw/media-core/mime";
import { resolveImageCompressionModelPolicy } from "../agents/image-compression-policy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isImageProcessorUnavailableError } from "../media/image-ops.js";
import { ImageOptimizationLimitError } from "../media/image-optimization-error.js";
import { normalizeInputImageBuffer } from "../media/input-files.js";
import { readImageMetadataFromHeader } from "../media/media-services.js";
import { effectiveImageBytesCap, optimizeImageBufferForWebMedia } from "../media/web-media.js";
import { MEDIA_CAPABILITY_DEFAULTS } from "./defaults.constants.js";

const CONVERTIBLE_MIME_RE = /^(?:image\/hei[cf]|image\/avif)(?:-sequence)?$/i;
const CONVERTIBLE_EXT_RE = /\.(heic|heif|avif)$/i;
const MEDIA_UNDERSTANDING_MAX_SOURCE_PIXELS = 40_000_000;

/** Normalizes image bytes before provider execution, converting AVIF/HEIC/HEIF inputs to JPEG. */
export async function normalizeImageDescriptionInput(params: {
  buffer: Buffer;
  fileName?: string;
  mime?: string;
  maxBytes?: number;
}): Promise<{ buffer: Buffer; mime?: string }> {
  const mime = normalizeMimeType(params.mime);
  if (
    !(mime && CONVERTIBLE_MIME_RE.test(mime)) &&
    !CONVERTIBLE_EXT_RE.test(params.fileName?.trim() ?? "")
  ) {
    return { buffer: params.buffer, mime: params.mime };
  }
  const sourceMime = mime ?? mimeTypeFromFilePath(params.fileName) ?? "image/heic";
  // Keep owned bytes through the shared MIME and size guards; only API content needs base64.
  let image: { buffer: Buffer; mimeType?: string };
  try {
    image = await normalizeInputImageBuffer({
      buffer: params.buffer,
      mimeType: sourceMime,
      limits: {
        allowedMimes: new Set([sourceMime, "image/avif", "image/heic", "image/heif", "image/jpeg"]),
        maxBytes: params.maxBytes ?? MEDIA_CAPABILITY_DEFAULTS.image.maxBytes,
      },
    });
  } catch (error) {
    if (!isImageProcessorUnavailableError(error)) {
      throw error;
    }
    // Hosts without a decoder for this format must surface a way forward instead of
    // the bare backend list, because normalization is now mandatory for these inputs.
    throw new Error(
      `${sourceMime} input needs a local image decoder; install an AVIF/HEIF-capable backend (ffmpeg, or ImageMagick 7 with libheif) or resend the image as JPEG/PNG/WebP`,
      { cause: error },
    );
  }
  return {
    buffer: image.buffer,
    mime: image.mimeType,
  };
}

/** Applies the selected model's image policy before bytes cross the provider boundary. */
export async function optimizeImageDescriptionInput(params: {
  buffer: Buffer;
  fileName?: string;
  mime?: string;
  maxBytes?: number;
  cfg?: OpenClawConfig;
  provider: string;
  model: string;
  agentDir?: string;
  workspaceDir?: string;
}): Promise<{ buffer: Buffer; fileName?: string; mime?: string }> {
  const maxBytes = params.maxBytes ?? MEDIA_CAPABILITY_DEFAULTS.image.maxBytes;
  const modelPolicy = await resolveImageCompressionModelPolicy(params);
  const imageCompression = { imageCount: 1, models: [modelPolicy] };
  const effectiveMaxBytes = effectiveImageBytesCap(maxBytes, imageCompression) ?? maxBytes;
  const hasModelLimits = [
    modelPolicy.maxSidePx,
    modelPolicy.maxPixels,
    modelPolicy.preferredSidePx,
    modelPolicy.maxBytes,
  ].some((limit) => limit !== undefined && limit > 0);
  // Undeclared limits and unknown formats retain the provider's existing input contract.
  if (!hasModelLimits || !readImageMetadataFromHeader(params.buffer)) {
    if (params.buffer.length > effectiveMaxBytes) {
      throw new ImageOptimizationLimitError(
        `Image exceeds maxBytes ${effectiveMaxBytes}`,
        effectiveMaxBytes,
      );
    }
    return { buffer: params.buffer, fileName: params.fileName, mime: params.mime };
  }
  const optimized = await optimizeImageBufferForWebMedia({
    buffer: params.buffer,
    contentType:
      normalizeMimeType(params.mime) ?? mimeTypeFromFilePath(params.fileName) ?? params.mime,
    fileName: params.fileName,
    maxBytes,
    imageCompression,
    maxInputPixels: MEDIA_UNDERSTANDING_MAX_SOURCE_PIXELS,
  });
  return {
    buffer: optimized.buffer,
    fileName: optimized.fileName ?? params.fileName,
    mime: optimized.contentType ?? params.mime,
  };
}
