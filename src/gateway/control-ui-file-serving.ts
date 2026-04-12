import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { WORKSPACE_FILE_PREFIX } from "./chat-image-transform.js";
import { isReadHttpMethod, respondNotFound } from "./control-ui-http-utils.js";
import { normalizeControlUiBasePath } from "./control-ui-shared.js";

/** Gateway-relative URL prefix used to proxy remote images for webchat. */
export const IMAGE_PROXY_PREFIX = "/__image_proxy__";

/**
 * Extensions allowed to be served through the workspace-file endpoint.
 * Only media types — never serve code or config files.
 */
const ALLOWED_MEDIA_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".bmp",
  ".ico",
  ".tiff",
  ".tif",
  ".avif",
  ".mp4",
  ".webm",
  ".ogg",
  ".mp3",
  ".wav",
  ".pdf",
]);

/** Max file size served through this endpoint (20 MB). */
const MAX_SERVE_BYTES = 20 * 1024 * 1024;

function contentTypeForMediaExt(ext: string): string | null {
  switch (ext) {
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
    case ".bmp":
      return "image/bmp";
    case ".ico":
      return "image/x-icon";
    case ".tiff":
    case ".tif":
      return "image/tiff";
    case ".avif":
      return "image/avif";
    case ".mp4":
      return "video/mp4";
    case ".webm":
      return "video/webm";
    case ".ogg":
      return "audio/ogg";
    case ".mp3":
      return "audio/mpeg";
    case ".wav":
      return "audio/wav";
    case ".pdf":
      return "application/pdf";
    default:
      return null;
  }
}

/**
 * Serves local workspace/media files requested via `/__file__/<base64url-path>`.
 *
 * Security:
 * - Only media-type file extensions are served.
 * - Null bytes in paths are rejected.
 * - Only regular files are served (no directories, symlinks traversal).
 * - Relies on gateway-level auth — this handler does NOT add its own auth.
 */
export function handleWorkspaceFileRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts?: { basePath?: string },
): boolean {
  const urlRaw = req.url;
  if (!urlRaw || !isReadHttpMethod(req.method)) {
    return false;
  }

  const url = new URL(urlRaw, "http://localhost");
  const basePath = normalizeControlUiBasePath(opts?.basePath);
  const filePrefix = basePath
    ? `${basePath}${WORKSPACE_FILE_PREFIX}/`
    : `${WORKSPACE_FILE_PREFIX}/`;

  if (!url.pathname.startsWith(filePrefix)) {
    return false;
  }

  const encoded = url.pathname.slice(filePrefix.length);
  if (!encoded) {
    respondNotFound(res);
    return true;
  }

  let decodedPath: string;
  try {
    decodedPath = Buffer.from(encoded, "base64url").toString("utf-8");
  } catch {
    respondNotFound(res);
    return true;
  }

  // Reject null bytes
  if (decodedPath.includes("\0")) {
    respondNotFound(res);
    return true;
  }

  // Must be an absolute path after decoding
  if (!path.isAbsolute(decodedPath)) {
    respondNotFound(res);
    return true;
  }

  // Normalize to prevent traversal tricks
  const normalizedPath = path.resolve(decodedPath);

  // Only serve files with allowed media extensions
  const ext = path.extname(normalizedPath).toLowerCase();
  if (!ALLOWED_MEDIA_EXTENSIONS.has(ext)) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Forbidden: unsupported file type");
    return true;
  }

  const contentType = contentTypeForMediaExt(ext);
  if (!contentType) {
    respondNotFound(res);
    return true;
  }

  try {
    const stat = fs.statSync(normalizedPath);
    if (!stat.isFile()) {
      respondNotFound(res);
      return true;
    }
    if (stat.size > MAX_SERVE_BYTES) {
      res.statusCode = 413;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("File too large");
      return true;
    }

    if (req.method === "HEAD") {
      res.statusCode = 200;
      res.setHeader("Content-Type", contentType);
      res.setHeader("Content-Length", String(stat.size));
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.end();
      return true;
    }

    const data = fs.readFileSync(normalizedPath);
    res.statusCode = 200;
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", String(data.length));
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end(data);
    return true;
  } catch {
    respondNotFound(res);
    return true;
  }
}

/** Max response body size for proxied remote images (10 MB). */
const IMAGE_PROXY_MAX_BYTES = 10 * 1024 * 1024;
/** Timeout for remote image fetches (10 seconds). */
const IMAGE_PROXY_TIMEOUT_MS = 10_000;

const IMAGE_PROXY_ALLOWED_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/bmp",
  "image/x-icon",
  "image/tiff",
  "image/avif",
]);

/**
 * Proxies remote images requested via `/__image_proxy__/<base64url-encoded-url>`.
 *
 * Fetches the remote resource server-side and streams it back to the browser,
 * avoiding CORS / mixed-content / hotlink-protection issues that affect
 * cross-origin `<img>` tags in the webchat UI.
 *
 * Security:
 * - Only http/https URLs are fetched.
 * - Only image content-types are forwarded.
 * - Response body is capped at IMAGE_PROXY_MAX_BYTES.
 * - Relies on gateway-level auth — this handler does NOT add its own auth.
 */
export async function handleImageProxyRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts?: { basePath?: string },
): Promise<boolean> {
  const urlRaw = req.url;
  if (!urlRaw || !isReadHttpMethod(req.method)) {
    return false;
  }

  const url = new URL(urlRaw, "http://localhost");
  const basePath = normalizeControlUiBasePath(opts?.basePath);
  const proxyPrefix = basePath ? `${basePath}${IMAGE_PROXY_PREFIX}/` : `${IMAGE_PROXY_PREFIX}/`;

  if (!url.pathname.startsWith(proxyPrefix)) {
    return false;
  }

  const encoded = url.pathname.slice(proxyPrefix.length);
  if (!encoded) {
    respondNotFound(res);
    return true;
  }

  let targetUrl: string;
  try {
    targetUrl = Buffer.from(encoded, "base64url").toString("utf-8");
  } catch {
    respondNotFound(res);
    return true;
  }

  // Only allow http/https URLs
  if (!/^https?:\/\//i.test(targetUrl)) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Bad Request: only http/https URLs are allowed");
    return true;
  }

  // Validate URL structure
  try {
    new URL(targetUrl);
  } catch {
    res.statusCode = 400;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Bad Request: invalid URL");
    return true;
  }

  // Block private/loopback addresses to prevent SSRF
  try {
    const parsed = new URL(targetUrl);
    const hostname = parsed.hostname.toLowerCase();
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "[::1]" ||
      hostname === "0.0.0.0" ||
      hostname.endsWith(".local") ||
      hostname.startsWith("10.") ||
      hostname.startsWith("192.168.") ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
      hostname === "169.254.169.254" ||
      hostname === "metadata.google.internal"
    ) {
      res.statusCode = 403;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Forbidden: private/internal addresses are not allowed");
      return true;
    }
  } catch {
    respondNotFound(res);
    return true;
  }

  if (req.method === "HEAD") {
    res.statusCode = 200;
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.end();
    return true;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), IMAGE_PROXY_TIMEOUT_MS);
    let upstream: Response;
    try {
      upstream = await fetch(targetUrl, {
        signal: controller.signal,
        redirect: "follow",
        headers: {
          Accept: "image/*",
          "User-Agent": "OpenClaw-ImageProxy/1.0",
        },
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!upstream.ok) {
      res.statusCode = 502;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(`Bad Gateway: upstream returned ${upstream.status}`);
      return true;
    }

    const contentType = upstream.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (!contentType || !IMAGE_PROXY_ALLOWED_CONTENT_TYPES.has(contentType)) {
      res.statusCode = 403;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Forbidden: upstream content-type is not an allowed image type");
      return true;
    }

    const contentLength = upstream.headers.get("content-length");
    if (contentLength && Number.parseInt(contentLength, 10) > IMAGE_PROXY_MAX_BYTES) {
      res.statusCode = 413;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Payload Too Large");
      return true;
    }

    if (!upstream.body) {
      respondNotFound(res);
      return true;
    }

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    const reader = upstream.body.getReader();
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      totalBytes += value.byteLength;
      if (totalBytes > IMAGE_PROXY_MAX_BYTES) {
        res.statusCode = 413;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Payload Too Large");
        return true;
      }
      chunks.push(value);
    }

    const body = Buffer.concat(chunks);
    res.statusCode = 200;
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", String(body.length));
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end(body);
    return true;
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      res.statusCode = 504;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Gateway Timeout: upstream image fetch timed out");
      return true;
    }
    res.statusCode = 502;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Bad Gateway: failed to fetch upstream image");
    return true;
  }
}
