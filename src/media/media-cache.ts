import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveConfigDir } from "../utils.js";
import type { MediaKind } from "./constants.js";
import { mediaKindFromMime } from "./constants.js";
import { extensionForMime } from "./mime.js";

export const MEDIA_CACHE_SUBDIR = "cache";
export const CACHED_MEDIA_MARKER_PREFIX = "[media cached: ";

const MEDIA_FILE_MODE = 0o644;
const MEDIA_DIR_MODE = 0o700;

function resolveCacheDir(): string {
  return path.join(resolveConfigDir(), "media", MEDIA_CACHE_SUBDIR);
}

/**
 * Cache a media content block (base64) to disk for later retrieval.
 *
 * Uses a SHA-256 content hash (truncated to 16 hex chars) for deduplication:
 * identical content always maps to the same file.
 *
 * @returns The absolute path and hash of the cached file.
 */
export async function cacheMediaToDisk(
  data: string,
  mimeType: string,
): Promise<{ path: string; hash: string }> {
  const buffer = Buffer.from(data, "base64");
  const hash = crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 16);
  const ext = extensionForMime(mimeType) ?? "";
  const fileName = `${hash}${ext}`;
  const dir = resolveCacheDir();
  const filePath = path.join(dir, fileName);

  // Dedup: skip write if file already exists with same hash
  try {
    await fs.access(filePath);
    return { path: filePath, hash };
  } catch {
    // File doesn't exist, proceed to write
  }

  await fs.mkdir(dir, { recursive: true, mode: MEDIA_DIR_MODE });
  await fs.writeFile(filePath, buffer, { mode: MEDIA_FILE_MODE });
  return { path: filePath, hash };
}

/**
 * Build a cached media marker string for embedding in pruned message text.
 *
 * Format: `[media cached: <path> (<mimeType>) kind=<kind>]`
 */
export function buildCachedMediaMarker(
  filePath: string,
  mimeType: string,
  kind: MediaKind,
): string {
  return `${CACHED_MEDIA_MARKER_PREFIX}${filePath} (${mimeType}) kind=${kind}]`;
}

/**
 * Derive the MediaKind for a given MIME type, defaulting to "document" for unknown types.
 */
export function mediaCacheKind(mimeType: string): MediaKind {
  return mediaKindFromMime(mimeType) ?? "document";
}
