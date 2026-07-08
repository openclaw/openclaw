// Image input normalization converts HEIC/HEIF payloads through the shared
// input-file media path before provider execution.
import { mimeTypeFromFilePath } from "@openclaw/media-core/mime";
import { extractImageContentFromSource, normalizeMimeType } from "../media/input-files.js";
import { optimizeImageBufferForWebMedia, type ImageCompressionPolicy } from "../media/web-media.js";
import { DEFAULT_MAX_BYTES } from "./defaults.constants.js";

const HEIC_MIME_RE = /^image\/hei[cf]$/i;
const HEIC_EXT_RE = /\.(heic|heif)$/i;

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
  const optimized = await optimizeImageBufferForWebMedia({
    buffer: params.buffer,
    contentType: mime,
    fileName: params.fileName,
    maxBytes: params.maxBytes,
    imageCompression: params.imageCompression,
  });
  return { buffer: optimized.buffer, mime: optimized.contentType ?? mime };
}

/** Normalizes image bytes before provider execution, converting HEIC/HEIF inputs to JPEG. */
export async function normalizeImageDescriptionInput(params: {
  buffer: Buffer;
  fileName?: string;
  imageCompression?: ImageCompressionPolicy;
  mime?: string;
  maxBytes?: number;
}): Promise<{ buffer: Buffer; mime?: string }> {
  const maxBytes = params.maxBytes ?? DEFAULT_MAX_BYTES.image;
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
      maxBytes,
      maxRedirects: 0,
      timeoutMs: 0,
    },
  );
  const normalized = {
    buffer: Buffer.from(image.data, "base64"),
    mime: image.mimeType,
  };
  return await maybeOptimizeImageDescriptionInput({
    buffer: normalized.buffer,
    fileName: params.fileName,
    maxBytes,
    imageCompression: params.imageCompression,
    mime: normalized.mime,
  });
}
