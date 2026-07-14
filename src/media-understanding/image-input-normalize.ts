// Image input normalization converts HEIC/HEIF payloads through the shared
// input-file media path before provider execution.
import { mimeTypeFromFilePath } from "@openclaw/media-core/mime";
import { extractImageContentFromSource, normalizeMimeType } from "../media/input-files.js";
import { optimizeImageBufferForWebMedia, type ImageCompressionPolicy } from "../media/web-media.js";
import { DEFAULT_MAX_BYTES } from "./defaults.constants.js";

const HEIC_MIME_RE = /^image\/hei[cf]$/i;
const HEIC_EXT_RE = /\.(heic|heif)$/i;

export class ImageDescriptionMaxBytesError extends Error {
  readonly maxBytes: number;

  constructor(maxBytes: number, cause?: unknown) {
    super(`Image exceeds maxBytes ${maxBytes}`, cause === undefined ? undefined : { cause });
    this.name = "ImageDescriptionMaxBytesError";
    this.maxBytes = maxBytes;
  }
}

export function isImageDescriptionMaxBytesError(
  err: unknown,
): err is ImageDescriptionMaxBytesError {
  return err instanceof ImageDescriptionMaxBytesError;
}

function isImageOptimizationMaxBytesError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const message = err.message.toLowerCase();
  return (
    message.includes("could not be reduced below") ||
    message.includes("exceeds maxbytes") ||
    (message.includes("exceeds") && message.includes("limit"))
  );
}

function isHeicInput(params: { mime?: string; fileName?: string }): boolean {
  const mime = normalizeMimeType(params.mime);
  if (mime && HEIC_MIME_RE.test(mime)) {
    return true;
  }
  const fileName = params.fileName?.trim();
  return Boolean(fileName && HEIC_EXT_RE.test(fileName));
}

function resolveImageInputMime(params: { mime?: string; fileName?: string }): string | undefined {
  return normalizeMimeType(params.mime) ?? mimeTypeFromFilePath(params.fileName) ?? params.mime;
}

async function maybeOptimizeImageDescriptionInput(params: {
  buffer: Buffer;
  fileName?: string;
  imageCompression?: ImageCompressionPolicy;
  maxBytes: number;
  mime?: string;
}): Promise<{ buffer: Buffer; mime?: string }> {
  if (!params.imageCompression) {
    return { buffer: params.buffer, mime: params.mime };
  }
  const mime = resolveImageInputMime(params);
  let optimized: Awaited<ReturnType<typeof optimizeImageBufferForWebMedia>>;
  try {
    optimized = await optimizeImageBufferForWebMedia({
      buffer: params.buffer,
      contentType: mime,
      fileName: params.fileName,
      maxBytes: params.maxBytes,
      imageCompression: params.imageCompression,
    });
  } catch (err) {
    if (isImageOptimizationMaxBytesError(err)) {
      throw new ImageDescriptionMaxBytesError(params.maxBytes, err);
    }
    throw err;
  }
  return { buffer: optimized.buffer, mime: optimized.contentType ?? mime };
}

function assertImageDescriptionMaxBytes(params: { buffer: Buffer; maxBytes: number }): void {
  if (params.buffer.length <= params.maxBytes) {
    return;
  }
  throw new ImageDescriptionMaxBytesError(params.maxBytes);
}

/** Normalizes image bytes before provider execution, converting HEIC/HEIF inputs to JPEG. */
export async function normalizeImageDescriptionInput(params: {
  buffer: Buffer;
  fileName?: string;
  imageCompression?: ImageCompressionPolicy;
  mime?: string;
  maxBytes?: number;
  sourceMaxBytes?: number;
}): Promise<{ buffer: Buffer; mime?: string }> {
  const maxBytes = params.maxBytes ?? DEFAULT_MAX_BYTES.image;
  const sourceMaxBytes = params.sourceMaxBytes ?? maxBytes;
  if (!isHeicInput(params)) {
    return await maybeOptimizeImageDescriptionInput({
      buffer: params.buffer,
      fileName: params.fileName,
      maxBytes,
      imageCompression: params.imageCompression,
      mime: params.mime,
    });
  }
  const sourceMime = normalizeMimeType(params.mime) ?? "image/heic";
  // Reuse input-file extraction so HEIC conversion follows the same MIME and size guards.
  const image = await extractImageContentFromSource(
    {
      type: "base64",
      data: params.buffer.toString("base64"),
      mediaType: sourceMime,
    },
    {
      allowUrl: false,
      allowedMimes: new Set([sourceMime.toLowerCase(), "image/heic", "image/heif", "image/jpeg"]),
      maxBytes: sourceMaxBytes,
      maxRedirects: 0,
      timeoutMs: 0,
    },
  );
  const normalized = {
    buffer: Buffer.from(image.data, "base64"),
    mime: image.mimeType,
  };
  const result = await maybeOptimizeImageDescriptionInput({
    buffer: normalized.buffer,
    fileName: params.fileName,
    maxBytes,
    imageCompression: params.imageCompression,
    mime: normalized.mime,
  });
  if (sourceMaxBytes > maxBytes) {
    assertImageDescriptionMaxBytes({ buffer: result.buffer, maxBytes });
  }
  return result;
}
