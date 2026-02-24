import fs from "node:fs/promises";
import path from "node:path";
import { SafeOpenError, openFileWithinRoot, type SafeOpenResult } from "../infra/fs-safe.js";

/** Extension-based MIME types for common web assets that content-sniffing misclassifies. */
const WEB_ASSET_MIME: Record<string, string> = {
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".wasm": "application/wasm",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

/**
 * Resolve MIME type for a canvas/a2ui file path by extension first, falling
 * back to the provided `fallback` callback (typically `detectMime`).
 */
export function mimeForCanvasFile(filePath: string, sniffed: string | undefined): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".html") || lower.endsWith(".htm")) {
    return "text/html";
  }
  const ext = path.extname(lower);
  if (ext && WEB_ASSET_MIME[ext]) {
    return WEB_ASSET_MIME[ext];
  }
  return sniffed ?? "application/octet-stream";
}

export function normalizeUrlPath(rawPath: string): string {
  const decoded = decodeURIComponent(rawPath || "/");
  const normalized = path.posix.normalize(decoded);
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

export async function resolveFileWithinRoot(
  rootReal: string,
  urlPath: string,
): Promise<SafeOpenResult | null> {
  const normalized = normalizeUrlPath(urlPath);
  const rel = normalized.replace(/^\/+/, "");
  if (rel.split("/").some((p) => p === "..")) {
    return null;
  }

  const tryOpen = async (relative: string) => {
    try {
      return await openFileWithinRoot({ rootDir: rootReal, relativePath: relative });
    } catch (err) {
      if (err instanceof SafeOpenError) {
        return null;
      }
      throw err;
    }
  };

  if (normalized.endsWith("/")) {
    return await tryOpen(path.posix.join(rel, "index.html"));
  }

  const candidate = path.join(rootReal, rel);
  try {
    const st = await fs.lstat(candidate);
    if (st.isSymbolicLink()) {
      return null;
    }
    if (st.isDirectory()) {
      return await tryOpen(path.posix.join(rel, "index.html"));
    }
  } catch {
    // ignore
  }

  return await tryOpen(rel);
}
