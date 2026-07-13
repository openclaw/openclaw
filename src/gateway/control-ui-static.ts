// Control UI static-response policy: MIME types, caching, encoding, and pinned-file reads.
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";

const CONTROL_UI_IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const CONTROL_UI_COMPRESSIBLE_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".map",
  ".svg",
  ".txt",
  ".webmanifest",
]);

/**
 * Missing files with these extensions return 404 instead of the SPA index.
 * `.html` stays excluded because client-side routes may use that suffix.
 */
const CONTROL_UI_STATIC_ASSET_EXTENSIONS = new Set([
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
  ".webmanifest",
]);

export function isControlUiStaticAssetExtension(extension: string): boolean {
  return CONTROL_UI_STATIC_ASSET_EXTENSIONS.has(extension);
}

type ControlUiContentEncoding = "br" | "gzip";

function contentTypeForExtension(ext: string): string {
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
    case ".webmanifest":
      return "application/manifest+json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function normalizedAcceptEncoding(req: IncomingMessage): string {
  const value = req.headers?.["accept-encoding"];
  return Array.isArray(value) ? value.join(",") : (value ?? "");
}

function resolveControlUiContentEncoding(req: IncomingMessage): ControlUiContentEncoding | null {
  const qualities = new Map<string, number>();
  for (const entry of normalizedAcceptEncoding(req).split(",")) {
    const [rawName, ...rawParams] = entry.split(";");
    const name = rawName?.trim().toLowerCase();
    if (!name) {
      continue;
    }
    const qualityParam = rawParams.find((param) => param.trim().toLowerCase().startsWith("q="));
    const parsedQuality = qualityParam ? Number.parseFloat(qualityParam.trim().slice(2)) : 1;
    const quality =
      Number.isFinite(parsedQuality) && parsedQuality >= 0 && parsedQuality <= 1
        ? parsedQuality
        : 0;
    qualities.set(name, Math.max(qualities.get(name) ?? 0, quality));
  }

  const wildcardQuality = qualities.get("*") ?? 0;
  const qualityFor = (name: ControlUiContentEncoding) =>
    qualities.has(name) ? (qualities.get(name) ?? 0) : wildcardQuality;
  const brotliQuality = qualityFor("br");
  const gzipQuality = qualityFor("gzip");
  if (brotliQuality <= 0 && gzipQuality <= 0) {
    return null;
  }
  return brotliQuality >= gzipQuality ? "br" : "gzip";
}

function setNegotiatedEncodingHeaders(
  req: IncomingMessage,
  res: ServerResponse,
  extension: string,
): ControlUiContentEncoding | null {
  if (!CONTROL_UI_COMPRESSIBLE_EXTENSIONS.has(extension)) {
    return null;
  }
  res.setHeader("Vary", "Accept-Encoding");
  const encoding = resolveControlUiContentEncoding(req);
  if (encoding) {
    res.setHeader("Content-Encoding", encoding);
  }
  return encoding;
}

function setControlUiFileHeaders(
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
  options?: { immutable?: boolean },
): ControlUiContentEncoding | null {
  const extension = path.extname(filePath).toLowerCase();
  res.setHeader("Content-Type", contentTypeForExtension(extension));
  res.setHeader(
    "Cache-Control",
    options?.immutable ? CONTROL_UI_IMMUTABLE_CACHE_CONTROL : "no-cache",
  );
  return setNegotiatedEncodingHeaders(req, res, extension);
}

export function respondHeadForControlUiFile(
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
  options?: { immutable?: boolean },
): boolean {
  if (req.method !== "HEAD") {
    return false;
  }
  res.statusCode = 200;
  setControlUiFileHeaders(req, res, filePath, options);
  res.end();
  return true;
}

function compressControlUiBody(body: Buffer, encoding: ControlUiContentEncoding): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const callback = (error: Error | null, compressed: Buffer) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(compressed);
    };
    if (encoding === "br") {
      brotliCompress(
        body,
        {
          params: {
            [zlibConstants.BROTLI_PARAM_QUALITY]: 4,
          },
        },
        callback,
      );
      return;
    }
    gzip(body, { level: 6 }, callback);
  });
}

export async function serveControlUiAsset(
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
  body: Buffer,
  options?: { immutable?: boolean },
) {
  const encoding = setControlUiFileHeaders(req, res, filePath, options);
  res.end(encoding ? await compressControlUiBody(body, encoding) : body);
}

export async function sendControlUiHtmlBody(
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
) {
  const encoding = setNegotiatedEncodingHeaders(req, res, ".html");
  res.end(encoding ? await compressControlUiBody(Buffer.from(body), encoding) : body);
}

function readOpenedFile(fd: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    fs.readFile(fd, (error, data) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(data);
    });
  });
}

// Compression can wait in zlib's worker queue, so release the pinned file as
// soon as its bytes are loaded instead of retaining descriptors per request.
export async function readAndCloseControlUiFile(fd: number): Promise<Buffer> {
  try {
    return await readOpenedFile(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export async function readAndCloseControlUiFileText(fd: number): Promise<string> {
  return (await readAndCloseControlUiFile(fd)).toString("utf8");
}
