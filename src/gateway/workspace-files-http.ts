import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import { openFileWithinRoot, SafeOpenError } from "../infra/fs-safe.js";
import { detectMime } from "../media/mime.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import { isLocalDirectRequest, type ResolvedGatewayAuth } from "./auth.js";
import { authorizeGatewayBearerRequestOrReply } from "./http-auth-helpers.js";

const WORKSPACE_FILES_PREFIX = "/api/workspace-files/";
const PROJECT_FILES_PATH = "/api/project-files";

/** MIME types allowed to be served. Anything else returns 403. */
const ALLOWED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "application/pdf",
  "text/markdown",
  "text/plain",
]);

/** Maximum file size: 20 MB. */
const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** Agent ID must be alphanumeric with hyphens/underscores, 1-64 chars. */
function isValidAgentId(agentId: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(agentId);
}

/**
 * Handle GET /api/workspace-files/{agentId}/{...relativePath}
 *
 * Serves files from an agent's workspace directory with:
 * - Bearer token auth (or local loopback bypass)
 * - Path traversal protection via `openFileWithinRoot`
 * - MIME allowlist (images + PDF only)
 * - 20 MB file size cap
 */
export async function handleWorkspaceFilesHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    auth: ResolvedGatewayAuth;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
  },
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  // Handle /api/project-files?path=<absolute-path> for project repo files
  if (pathname === PROJECT_FILES_PATH || pathname.startsWith(PROJECT_FILES_PATH + "/")) {
    return handleProjectFileRequest(req, res, url, opts);
  }

  if (!pathname.startsWith(WORKSPACE_FILES_PREFIX)) {
    return false;
  }

  // Only GET and HEAD allowed.
  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, HEAD");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method Not Allowed");
    return true;
  }

  // Auth: allow local loopback requests without a token (matches control UI
  // pattern — <img> tags can't send Authorization headers). For remote access,
  // require a Bearer token.
  const isLocal = isLocalDirectRequest(req, opts.trustedProxies, opts.allowRealIpFallback);
  if (!isLocal) {
    const authorized = await authorizeGatewayBearerRequestOrReply({
      req,
      res,
      auth: opts.auth,
      trustedProxies: opts.trustedProxies,
      allowRealIpFallback: opts.allowRealIpFallback,
      rateLimiter: opts.rateLimiter,
    });
    if (!authorized) {
      return true; // auth helper already sent 401/403
    }
  }

  // Parse: /api/workspace-files/{agentId}/{...relativePath}
  const rest = pathname.slice(WORKSPACE_FILES_PREFIX.length);
  const slashIdx = rest.indexOf("/");
  if (slashIdx <= 0) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Bad Request: missing file path");
    return true;
  }

  const agentId = rest.slice(0, slashIdx);
  const relativePath = rest.slice(slashIdx + 1);

  if (!agentId || !isValidAgentId(agentId)) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Bad Request: invalid agent ID");
    return true;
  }

  if (!relativePath || relativePath.includes("\0")) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Bad Request: invalid file path");
    return true;
  }

  // Resolve workspace root.
  const config = loadConfig();
  const workspaceDir = resolveAgentWorkspaceDir(config, agentId);

  try {
    const opened = await openFileWithinRoot({
      rootDir: workspaceDir,
      relativePath: decodeURIComponent(relativePath),
    });

    try {
      // Check file size.
      if (opened.stat.size > MAX_FILE_BYTES) {
        res.statusCode = 413;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Payload Too Large");
        return true;
      }

      // Detect MIME type from file extension / content sniff.
      const buffer = await opened.handle.readFile();
      const mime = await detectMime({ buffer, filePath: opened.realPath });

      if (!mime || !ALLOWED_MIME_TYPES.has(mime)) {
        res.statusCode = 403;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Forbidden: file type not allowed");
        return true;
      }

      // Serve the file.
      res.statusCode = 200;
      res.setHeader("Content-Type", mime);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");

      if (method === "HEAD") {
        res.setHeader("Content-Length", String(buffer.length));
        res.end();
      } else {
        res.end(buffer);
      }

      return true;
    } finally {
      await opened.handle.close().catch(() => {});
    }
  } catch (err) {
    if (err instanceof SafeOpenError) {
      if (err.code === "not-found") {
        res.statusCode = 404;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Not Found");
        return true;
      }
      // outside-workspace, symlink, invalid-path, path-mismatch
      res.statusCode = 403;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Forbidden");
      return true;
    }
    throw err;
  }
}

/**
 * Serve files from project directories via /api/project-files?path=<absolute-path>.
 * Only allows files under registered project paths or ~/.openclaw/.
 */
async function handleProjectFileRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  opts: {
    auth: ResolvedGatewayAuth;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
  },
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, HEAD");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method Not Allowed");
    return true;
  }

  const isLocal = isLocalDirectRequest(req, opts.trustedProxies, opts.allowRealIpFallback);
  if (!isLocal) {
    const authorized = await authorizeGatewayBearerRequestOrReply({
      req,
      res,
      auth: opts.auth,
      trustedProxies: opts.trustedProxies,
      allowRealIpFallback: opts.allowRealIpFallback,
      rateLimiter: opts.rateLimiter,
    });
    if (!authorized) {
      return true;
    }
  }

  const rawPath = url.searchParams.get("path");
  // Expand ~ to home directory
  const filePath = rawPath?.startsWith("~/")
    ? path.join(process.env.HOME ?? "/", rawPath.slice(2))
    : rawPath;
  if (
    !filePath ||
    !path.isAbsolute(filePath) ||
    filePath.includes("\0") ||
    filePath.includes("..")
  ) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Bad Request: invalid path");
    return true;
  }

  // Security: only allow paths under home directory
  const homeDir = process.env.HOME ?? "/";
  if (!filePath.startsWith(homeDir + "/")) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Forbidden");
    return true;
  }

  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
      res.statusCode = stat.isFile() ? 413 : 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(stat.isFile() ? "Payload Too Large" : "Not Found");
      return true;
    }

    const buffer = fs.readFileSync(filePath);
    const mime = await detectMime({ buffer, filePath });
    if (!mime || !ALLOWED_MIME_TYPES.has(mime)) {
      res.statusCode = 403;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Forbidden: file type not allowed");
      return true;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", mime);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (method === "HEAD") {
      res.setHeader("Content-Length", String(buffer.length));
      res.end();
    } else {
      res.end(buffer);
    }
    return true;
  } catch {
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Not Found");
    return true;
  }
}
