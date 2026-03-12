import path from "node:path";
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
 * Handles MEDIA: prefix (used by agent tools), file:// URLs, ~ expansion,
 * and plain paths (including relative).
 * Consistent with the resolution logic in loadWebMediaInternal.
 */
function resolveLocalOutboundPath(mediaUrl: string): string {
  // Strip the MEDIA: prefix that agent tools (e.g. TTS) prepend to media paths.
  // loadWebMedia strips it internally; we must do the same before resolving the path.
  const stripped = mediaUrl.replace(/^\s*MEDIA\s*:\s*/i, "");
  if (stripped.startsWith("file://")) {
    try {
      return fileURLToPath(stripped);
    } catch {
      // Fall through: return as-is if URL is malformed
    }
  }
  if (stripped.startsWith("~")) {
    return resolveUserPath(stripped);
  }
  // Resolve relative paths to absolute so downstream processes (e.g. signal-cli)
  // can locate the file regardless of their working directory.
  return path.resolve(stripped);
}

export async function resolveOutboundAttachmentFromUrl(
  mediaUrl: string,
  maxBytes: number,
  options?: { localRoots?: readonly string[] },
): Promise<{ path: string; contentType?: string }> {
  // Strip the MEDIA: prefix before any further processing so that isRemoteMediaUrl
  // and loadWebMedia both see the bare URL/path. Without this, a MEDIA:-prefixed
  // remote URL (e.g. "MEDIA:https://...") would fail the isRemoteMediaUrl check
  // and enter the local-file path, producing a path.resolve("https://...") garbage path.
  const trimmed = mediaUrl.trim().replace(/^\s*MEDIA\s*:\s*/i, "");
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
    const resolvedPath = resolveLocalOutboundPath(trimmed);
    // If the file fits within the limit (no optimization was needed), short-circuit.
    // If loadWebMedia had to optimize the image to fit, media.buffer already contains
    // the correctly sized result — persist that instead of returning the oversized original.
    if (media.buffer.byteLength <= maxBytes) {
      return { path: resolvedPath, contentType: media.contentType };
    }
    // Fallback: file needed optimization; persist the optimized buffer.
    const saved = await saveMediaBuffer(
      media.buffer,
      media.contentType ?? undefined,
      "outbound",
      maxBytes,
      media.fileName ?? undefined,
    );
    return { path: saved.path, contentType: saved.contentType };
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
