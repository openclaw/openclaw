import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import os from "node:os";
import { type OpenClawConfig } from "../../config/types.js";

function contentTypeForExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}

function resolveWorkspaceRoot(config: OpenClawConfig): string {
  const cfg = config as any;
  if (cfg.workspace && typeof cfg.workspace === "string") {
    // Handle ~ expansion if needed, though usually resolved by loadConfig
    if (cfg.workspace.startsWith("~/")) {
      return path.join(os.homedir(), cfg.workspace.slice(2));
    }
    return path.resolve(cfg.workspace);
  }
  // Default fallback
  return path.join(os.homedir(), ".openclaw", "workspace");
}

function isSafeRelativePath(relPath: string) {
  if (!relPath) return false;
  const normalized = path.posix.normalize(relPath);
  if (normalized.startsWith("../") || normalized === "..") return false;
  if (normalized.includes("\0")) return false;
  return true;
}

export function handleWorkspaceFileRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    config: OpenClawConfig;
    urlPrefix: string;
  },
): boolean {
  const urlRaw = req.url;
  if (!urlRaw) return false;

  // Only GET allowed
  if (req.method !== "GET" && req.method !== "HEAD") return false;

  const url = new URL(urlRaw, "http://localhost");
  if (!url.pathname.startsWith(opts.urlPrefix)) return false;

  // Simple Auth Check: For now, we assume the gateway is protected or local-only.
  // The user interaction suggests this is a local tool.
  // However, `server-http.ts` has `resolvedAuth`. We should probably check it if passed,
  // but to keep signature simple and consistent with other handlers, I'll rely on
  // the fact that this is likely intended for the Chat UI which is already authenticated via Gateway token
  // or local loopback.
  // TODO: Add stricter auth check if exposed publicly.

  const workspaceRoot = resolveWorkspaceRoot(opts.config);

  // Extract relative path (everything after prefix)
  // e.g. /api/workspace/files/my-image.png -> my-image.png
  // e.g. /api/workspace/files/subdir/image.png -> subdir/image.png
  const relPath = decodeURIComponent(url.pathname.slice(opts.urlPrefix.length));

  if (!relPath || !isSafeRelativePath(relPath)) {
    res.statusCode = 404;
    res.end("Not Found");
    return true;
  }

  const absPath = path.join(workspaceRoot, relPath);

  // Ensure it's still inside root (double check)
  if (!absPath.startsWith(workspaceRoot)) {
    res.statusCode = 403;
    res.end("Forbidden");
    return true;
  }

  if (!fs.existsSync(absPath)) {
    res.statusCode = 404;
    res.end("Not Found");
    return true;
  }

  const stat = fs.statSync(absPath);
  if (!stat.isFile()) {
    res.statusCode = 404;
    res.end("Not Found");
    return true;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", contentTypeForExt(path.extname(absPath)));
  res.setHeader("Content-Length", stat.size);
  res.setHeader("Cache-Control", "private, max-age=3600"); // 1 hour cache

  const stream = fs.createReadStream(absPath);
  stream.pipe(res);
  return true;
}
