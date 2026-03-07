import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { loadWebMedia } from "../web/media.js";
import { buildOutboundMediaLoadOptions } from "./load-options.js";
import { saveMediaBuffer } from "./store.js";

/**
 * Sanitize a filename to be safe as a filesystem basename.
 * Keeps alphanumeric, dots, hyphens, underscores, and Unicode letters/numbers.
 */
function sanitizeBasename(name: string): string {
  const trimmed = path.basename(name).trim();
  if (!trimmed) return "";
  const sanitized = trimmed.replace(/[^\p{L}\p{N}._-]+/gu, "_");
  return sanitized.replace(/_+/g, "_").replace(/^_|_$/g, "").slice(0, 200);
}

export async function resolveOutboundAttachmentFromUrl(
  mediaUrl: string,
  maxBytes: number,
  options?: { localRoots?: readonly string[] },
): Promise<{ path: string; contentType?: string }> {
  const media = await loadWebMedia(
    mediaUrl,
    buildOutboundMediaLoadOptions({
      maxBytes,
      mediaLocalRoots: options?.localRoots,
    }),
  );
  const saved = await saveMediaBuffer(
    media.buffer,
    media.contentType ?? undefined,
    "outbound",
    maxBytes,
  );

  // If the media has a known filename, expose it via a symlink in a
  // uuid-named subdirectory so downstream consumers (e.g. signal-cli)
  // see the original name as the file's basename rather than a UUID.
  if (media.fileName) {
    const cleanName = sanitizeBasename(media.fileName);
    if (cleanName) {
      const namedDir = path.join(path.dirname(saved.path), crypto.randomUUID());
      await fs.mkdir(namedDir, { recursive: true, mode: 0o700 });
      const namedPath = path.join(namedDir, cleanName);
      await fs.symlink(saved.path, namedPath);
      return { path: namedPath, contentType: saved.contentType };
    }
  }

  return { path: saved.path, contentType: saved.contentType };
}
