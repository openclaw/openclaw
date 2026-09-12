// Image input normalization converts HEIC/HEIF payloads through the shared
// input-file media path before provider execution.
import { mimeTypeFromFilePath, normalizeMimeType } from "@openclaw/media-core/mime";
import { resolveImageCompressionModelPolicy } from "../agents/image-compression-policy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ImageOptimizationLimitError } from "../media/image-optimization-error.js";
import { normalizeInputImageBuffer } from "../media/input-files.js";
import { readImageMetadataFromHeader } from "../media/media-services.js";
import { effectiveImageBytesCap, optimizeImageBufferForWebMedia } from "../media/web-media.js";
import { DEFAULT_MAX_BYTES } from "./defaults.constants.js";

const HEIC_MIME_RE = /^image\/hei[cf](?:-sequence)?$/i;
const HEIC_EXT_RE = /\.(heic|heif)$/i;
const MEDIA_UNDERSTANDING_MAX_SOURCE_PIXELS = 40_000_000;

function isHeicInput(params: { mime?: string; fileName?: string }): boolean {
  const mime = normalizeMimeType(params.mime);
  if (mime && HEIC_MIME_RE.test(mime)) {
    return true;
  }
  const fileName = params.fileName?.trim();
  return Boolean(fileName && HEIC_EXT_RE.test(fileName));
}

/** Normalizes image bytes before provider execution, converting HEIC/HEIF inputs to JPEG. */
export async function normalizeImageDescriptionInput(params: {
  buffer: Buffer;
  fileName?: string;
  mime?: string;
  maxBytes?: number;
}): Promise<{ buffer: Buffer; mime?: string }> {
  if (!isHeicInput(params)) {
    return { buffer: params.buffer, mime: params.mime };
  }
  const sourceMime = normalizeMimeType(params.mime) ?? "image/heic";
  // Keep owned bytes through the shared MIME and size guards; only API content needs base64.
  const image = await normalizeInputImageBuffer({
    buffer: params.buffer,
    mimeType: sourceMime,
    limits: {
      allowedMimes: new Set([sourceMime.toLowerCase(), "image/heic", "image/heif", "image/jpeg"]),
      maxBytes: params.maxBytes ?? DEFAULT_MAX_BYTES.image,
    },
  });
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
  const maxBytes = params.maxBytes ?? DEFAULT_MAX_BYTES.image;
  const modelPolicy = await resolveImageCompressionModelPolicy(params);
  const imageCompression = { imageCount: 1, models: [modelPolicy] };
  const effectiveMaxBytes = effectiveImageBytesCap(maxBytes, imageCompression) ?? maxBytes;
  // Unknown formats remain provider-owned; making Rastermill decode support a new plugin contract
  // would regress custom providers that already accept their own image formats.
  if (!readImageMetadataFromHeader(params.buffer)) {
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
