// Image input normalization converts HEIC/HEIF payloads through the shared
// input-file media path before provider execution, and downscales oversized
// images to respect agents.defaults.imageMaxDimensionPx.
import { readImageMetadataFromHeader, resizeToJpeg } from "../media/image-ops.js";
import { extractImageContentFromSource, normalizeMimeType } from "../media/input-files.js";
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

/** Normalizes image bytes before provider execution, converting HEIC/HEIF inputs
 *  to JPEG and downscaling oversized images to maxSide when configured. */
export async function normalizeImageDescriptionInput(params: {
  buffer: Buffer;
  fileName?: string;
  mime?: string;
  maxBytes?: number;
  maxSide?: number;
  quality?: number;
}): Promise<{ buffer: Buffer; mime?: string }> {
  let buffer = params.buffer;
  let mime = params.mime;

  if (isHeicInput(params)) {
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
        maxBytes: params.maxBytes ?? DEFAULT_MAX_BYTES.image,
        maxRedirects: 0,
        timeoutMs: 0,
      },
    );
    buffer = Buffer.from(image.data, "base64");
    mime = image.mimeType;
  }

  if (params.maxSide) {
    const header = readImageMetadataFromHeader(buffer);
    const longerSide = header ? Math.max(header.width, header.height) : undefined;
    if (longerSide !== undefined && longerSide > params.maxSide) {
      buffer = await resizeToJpeg({
        buffer,
        maxSide: params.maxSide,
        quality: params.quality ?? 85,
      });
      mime = "image/jpeg";
    }
  }

  return { buffer, mime };
}
