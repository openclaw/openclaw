import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { detectMime, extensionForMime } from "../../media/mime.js";
import { resolveConfigDir } from "../../utils.js";
import { UPLOAD_MAX_BYTES, UPLOAD_TTL_MS, isBlockedExtension } from "./constants.js";

/**
 * Saved upload metadata
 */
export type SavedUpload = {
  id: string;
  path: string;
  fileName: string;
  mimeType?: string;
  size: number;
  createdAt: number;
};

/**
 * Resolve the uploads directory path (~/.openclaw/uploads/)
 */
export function resolveUploadsDir(): string {
  return path.join(resolveConfigDir(), "uploads");
}

/**
 * Ensure uploads directory exists with secure permissions
 */
export async function ensureUploadsDir(): Promise<string> {
  const uploadsDir = resolveUploadsDir();
  await fs.mkdir(uploadsDir, { recursive: true, mode: 0o700 });
  return uploadsDir;
}

/**
 * Sanitize a filename for cross-platform safety.
 * Removes chars unsafe on Windows/SharePoint/all platforms.
 * Keeps: alphanumeric, dots, hyphens, underscores, Unicode letters/numbers.
 */
function sanitizeFilename(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    return "";
  }
  const sanitized = trimmed.replace(/[^\p{L}\p{N}._-]+/gu, "_");
  // Collapse multiple underscores, trim leading/trailing, limit length
  return sanitized.replace(/_+/g, "_").replace(/^_|_$/g, "").slice(0, 60);
}

/**
 * Extract original filename from stored path if it matches the embedded format.
 * Pattern: {original}---{uuid}.{ext} → returns "{original}.{ext}"
 */
export function extractOriginalFilename(filePath: string): string {
  const basename = path.basename(filePath);
  if (!basename) {
    return "file.bin";
  }

  const ext = path.extname(basename);
  const nameWithoutExt = path.basename(basename, ext);

  // Check for ---{uuid} pattern (36 chars: 8-4-4-4-12 with hyphens)
  const match = nameWithoutExt.match(
    /^(.+)---[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i,
  );
  if (match?.[1]) {
    return `${match[1]}${ext}`;
  }

  return basename;
}

/**
 * Save an uploaded file to disk
 */
export async function saveUpload(
  buffer: Buffer,
  fileName: string,
  mimeTypeHint?: string,
  maxBytes = UPLOAD_MAX_BYTES,
): Promise<SavedUpload> {
  // Check size limit
  if (buffer.byteLength > maxBytes) {
    throw new Error(`Upload exceeds ${(maxBytes / (1024 * 1024)).toFixed(0)}MB limit`);
  }

  // Parse and validate extension
  const parsedPath = path.parse(fileName);
  const ext = parsedPath.ext.toLowerCase() || "";

  if (isBlockedExtension(ext)) {
    throw new Error(`File type not allowed: ${ext}`);
  }

  // Detect MIME type
  const mime = await detectMime({ buffer, headerMime: mimeTypeHint, filePath: fileName });

  // Build filename: {sanitized}---{uuid}.{ext}
  const uuid = crypto.randomUUID();
  const sanitized = sanitizeFilename(parsedPath.name);
  const finalExt = ext || extensionForMime(mime) || "";
  const id = sanitized ? `${sanitized}---${uuid}${finalExt}` : `${uuid}${finalExt}`;

  // Ensure directory and write file
  const uploadsDir = await ensureUploadsDir();
  const destPath = path.join(uploadsDir, id);
  await fs.writeFile(destPath, buffer, { mode: 0o600 });

  return {
    id,
    path: destPath,
    fileName,
    mimeType: mime,
    size: buffer.byteLength,
    createdAt: Date.now(),
  };
}

/**
 * Clean up uploads older than TTL
 */
export async function cleanOldUploads(ttlMs = UPLOAD_TTL_MS): Promise<number> {
  const uploadsDir = resolveUploadsDir();
  let cleaned = 0;

  try {
    const entries = await fs.readdir(uploadsDir);
    const now = Date.now();

    await Promise.all(
      entries.map(async (file) => {
        const fullPath = path.join(uploadsDir, file);
        try {
          const stat = await fs.stat(fullPath);
          if (now - stat.mtimeMs > ttlMs) {
            await fs.rm(fullPath);
            cleaned++;
          }
        } catch {
          // Ignore individual file errors
        }
      }),
    );
  } catch {
    // Directory doesn't exist yet, nothing to clean
  }

  return cleaned;
}

/**
 * Get upload by ID (returns path if exists)
 */
export async function getUpload(id: string): Promise<string | null> {
  const uploadsDir = resolveUploadsDir();
  const fullPath = path.join(uploadsDir, id);

  // Security: ensure path doesn't escape uploads dir
  const resolved = path.resolve(fullPath);
  if (!resolved.startsWith(path.resolve(uploadsDir) + path.sep)) {
    return null;
  }

  try {
    await fs.access(fullPath);
    return fullPath;
  } catch {
    return null;
  }
}
