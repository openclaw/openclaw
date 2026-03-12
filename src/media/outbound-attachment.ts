import { fileURLToPath } from "node:url";
import { resolveUserPath } from "../utils.js";
import { loadWebMedia } from "../web/media.js";
import { buildOutboundMediaLoadOptions } from "./load-options.js";
import { saveMediaBuffer } from "./store.js";

/**
 * Returns true for remote URLs (http/https) or data: URIs.
 * Local file paths and file:// URLs are considered local.
 */
function isRemoteMediaUrl(mediaUrl: string): boolean {
  return /^https?:\/\//i.test(mediaUrl) || /^data:/i.test(mediaUrl);
}

/**
 * Resolves a local media URL or path to an absolute filesystem path.
 * Handles file:// URLs, ~ expansion, and plain absolute/relative paths.
 * Consistent with the resolution logic in loadWebMediaInternal.
 */
function resolveLocalOutboundPath(mediaUrl: string): string {
  if (mediaUrl.startsWith("file://")) {
    try {
      return fileURLToPath(mediaUrl);
    } catch {
      // Fall through: return as-is if URL is malformed
    }
  }
  if (mediaUrl.startsWith("~")) {
    return resolveUserPath(mediaUrl);
  }
  return mediaUrl;
}

export async function resolveOutboundAttachmentFromUrl(
  mediaUrl: string,
  maxBytes: number,
  options?: { localRoots?: readonly string[] },
): Promise<{ path: string; contentType?: string }> {
  const trimmed = mediaUrl.trim();
  const media = await loadWebMedia(
    trimmed,
    buildOutboundMediaLoadOptions({
      maxBytes,
      mediaLocalRoots: options?.localRoots,
    }),
  );

  // For local files already on disk, return the original path directly instead
  // of re-saving with a UUID-based name. Re-saving would discard the human-readable
  // filename, causing outbound attachments (e.g. Signal) to arrive as UUID blobs.
  if (!isRemoteMediaUrl(trimmed)) {
    return {
      path: resolveLocalOutboundPath(trimmed),
      contentType: media.contentType,
    };
  }

  // Remote media: buffer is downloaded; persist to temp store.
  // Pass fileName so the store can embed the original name (e.g. "report.pdf---<uuid>.pdf").
  const saved = await saveMediaBuffer(
    media.buffer,
    media.contentType ?? undefined,
    "outbound",
    maxBytes,
    media.fileName ?? undefined,
  );
  return { path: saved.path, contentType: saved.contentType };
}
