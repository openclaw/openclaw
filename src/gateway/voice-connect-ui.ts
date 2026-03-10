import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { openBoundaryFileSync } from "../infra/boundary-file-read.js";
import { isWithinDir } from "../infra/path-safety.js";
import { openVerifiedFileSync } from "../infra/safe-open-sync.js";
import { respondPlainText, respondNotFound, isReadHttpMethod } from "./control-ui-http-utils.js";
import { classifyVoiceConnectUiRequest } from "./voice-connect-ui-routing.js";
import { normalizeVoiceConnectBasePath } from "./voice-connect-ui-shared.js";

const VOICE_CONNECT_ASSETS_MISSING_MESSAGE =
  "Voice Connect UI assets not found. Build the voice-connect app and point gateway.voiceConnectUi.root to its dist folder.";

const STATIC_ASSET_EXTENSIONS = new Set([
  ".js",
  ".css",
  ".json",
  ".map",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".txt",
  ".woff",
  ".woff2",
]);

function contentTypeForExt(ext: string): string {
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
    case ".map":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".ico":
      return "image/x-icon";
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

function setStaticFileHeaders(res: ServerResponse, filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  res.setHeader("Content-Type", contentTypeForExt(ext));
  if (ext === ".html") {
    res.setHeader("Cache-Control", "no-cache");
  } else {
    // Cache-bust by hashed filenames.
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  }
  res.setHeader("X-Content-Type-Options", "nosniff");
}

function respondAssetsUnavailable(res: ServerResponse, root?: string) {
  if (root) {
    respondPlainText(
      res,
      503,
      `Voice Connect UI assets not found at ${root}. ${VOICE_CONNECT_ASSETS_MISSING_MESSAGE}`,
    );
    return;
  }
  respondPlainText(res, 503, VOICE_CONNECT_ASSETS_MISSING_MESSAGE);
}

function resolveRootFromConfig(cfg?: OpenClawConfig): string | null {
  const root = cfg?.gateway?.voiceConnectUi?.root;
  if (!root) return null;
  return String(root);
}

export function handleVoiceConnectUiHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { basePath?: string; config?: OpenClawConfig },
): boolean {
  const urlRaw = req.url;
  if (!urlRaw) return false;
  if (!isReadHttpMethod(req.method)) return false;

  const url = new URL(urlRaw, "http://localhost");
  const basePath = normalizeVoiceConnectBasePath(opts.basePath);
  const classified = classifyVoiceConnectUiRequest({ url, basePath });
  if (classified.kind === "none") return false;
  if (classified.kind === "redirect") {
    res.statusCode = 302;
    res.setHeader("Location", classified.location);
    res.end();
    return true;
  }

  const root = resolveRootFromConfig(opts.config);
  if (!root) {
    respondAssetsUnavailable(res);
    return true;
  }

  const rootReal = fs.existsSync(root) ? fs.realpathSync(root) : null;
  if (!rootReal || !fs.existsSync(path.join(rootReal, "index.html"))) {
    respondAssetsUnavailable(res, root);
    return true;
  }

  // Remove basePath prefix and normalize.
  const rel = classified.pathname.slice(basePath.length).replace(/^\/+/, "");
  const candidate = rel || "index.html";
  const ext = path.extname(candidate).toLowerCase();

  // Prevent traversal.
  const filePath = path.join(rootReal, candidate);
  if (!isWithinDir(rootReal, filePath)) {
    respondNotFound(res);
    return true;
  }

  // If request looks like a missing static asset, do not SPA-fallback.
  if (ext && STATIC_ASSET_EXTENSIONS.has(ext) && !fs.existsSync(filePath)) {
    respondNotFound(res);
    return true;
  }

  // Choose index.html fallback for non-existing routes.
  const finalPath = fs.existsSync(filePath) && fs.statSync(filePath).isFile()
    ? filePath
    : path.join(rootReal, "index.html");

  try {
    const fd = openVerifiedFileSync(finalPath);
    try {
      const boundaryFd = openBoundaryFileSync(rootReal, finalPath, fd);
      try {
        setStaticFileHeaders(res, finalPath);
        if (req.method === "HEAD") {
          res.statusCode = 200;
          res.end();
          return true;
        }
        res.statusCode = 200;
        res.end(fs.readFileSync(boundaryFd));
        return true;
      } finally {
        fs.closeSync(boundaryFd);
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    respondNotFound(res);
    return true;
  }
}
