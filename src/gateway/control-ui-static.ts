// Control UI static-response policy: MIME types, caching, and encoding.
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { brotliCompress, constants as zlibConstants, gzip } from "node:zlib";
import {
  resolveHttpContentEncodings,
  type HttpContentEncoding as ControlUiContentEncoding,
  type HttpRepresentationEncoding as ControlUiRepresentationEncoding,
} from "../infra/http-content-encoding.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { getOrCreatePromise } from "../shared/lazy-promise.js";
import type { ControlUiRootAsset } from "./control-ui-file.js";
import { respondPlainText } from "./control-ui-http-utils.js";
import { matchesHttpIfModifiedSince } from "./http-conditional.js";

const CONTROL_UI_IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const CONTROL_UI_HTML_COMPRESSION_CACHE_MAX_ENTRIES = 4;
const CONTROL_UI_COMPRESSIBLE_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".svg",
  ".txt",
  ".wasm",
  ".webmanifest",
]);
const CONTROL_UI_PRECOMPRESSED_ASSET_EXTENSIONS = new Set([".br", ".gz"]);

const CONTROL_UI_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".woff2": "font/woff2",
};

export function isControlUiStaticAssetExtension(extension: string): boolean {
  // Missing .html paths can be client-side routes; the other known types stay 404.
  return extension !== ".html" && Object.hasOwn(CONTROL_UI_CONTENT_TYPES, extension);
}

export function isControlUiPrecompressedAssetExtension(extension: string): boolean {
  return CONTROL_UI_PRECOMPRESSED_ASSET_EXTENSIONS.has(extension);
}

type ControlUiEncodingSelection = ControlUiRepresentationEncoding | "not-acceptable";

const CONTROL_UI_DYNAMIC_ENCODINGS = new Set<ControlUiContentEncoding>(["br", "gzip"]);
const controlUiHtmlCompressionCache = new Map<string, Promise<Buffer>>();
const compressBrotli = promisify(brotliCompress);
const compressGzip = promisify(gzip);

export function resolveControlUiHtmlEncoding(req: IncomingMessage): ControlUiEncodingSelection {
  return (
    resolveHttpContentEncodings(
      req.headers?.["accept-encoding"],
      CONTROL_UI_DYNAMIC_ENCODINGS,
    )[0] ?? "not-acceptable"
  );
}

export function isControlUiCompressibleAsset(filePath: string): boolean {
  return CONTROL_UI_COMPRESSIBLE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

type ControlUiRepresentation = {
  file: ControlUiRootAsset["file"];
  encoding?: ControlUiContentEncoding;
};

export function resolveControlUiRepresentation(params: {
  req: IncomingMessage;
  asset: ControlUiRootAsset;
  contentPath: string;
  precompressed: boolean;
}): ControlUiRepresentation | null {
  const { req, asset, precompressed } = params;
  const encodings = resolveHttpContentEncodings(
    req.headers?.["accept-encoding"],
    precompressed && isControlUiCompressibleAsset(params.contentPath)
      ? CONTROL_UI_DYNAMIC_ENCODINGS
      : new Set<ControlUiContentEncoding>(),
  );
  // A missing sidecar changes availability, not this request's encoding preferences.
  for (const selected of encodings) {
    if (selected === "identity") {
      return { file: asset.file };
    }
    const file = asset[selected];
    if (file instanceof Error) {
      throw file;
    }
    if (file) {
      return { file, encoding: selected };
    }
  }
  return null;
}

function setControlUiEncodingHeaders(
  res: ServerResponse,
  extension: string,
  encoding: ControlUiRepresentationEncoding,
) {
  res.setHeader("Vary", "Accept-Encoding");
  if (!CONTROL_UI_COMPRESSIBLE_EXTENSIONS.has(extension)) {
    return;
  }
  if (encoding !== "identity") {
    res.setHeader("Content-Encoding", encoding);
  }
}

function setControlUiFileHeaders(
  res: ServerResponse,
  filePath: string,
  options?: { immutable?: boolean; encoding?: ControlUiContentEncoding; lastModifiedMs?: number },
) {
  const extension = path.extname(filePath).toLowerCase();
  res.setHeader("Content-Type", CONTROL_UI_CONTENT_TYPES[extension] ?? "application/octet-stream");
  res.setHeader(
    "Cache-Control",
    options?.immutable ? CONTROL_UI_IMMUTABLE_CACHE_CONTROL : "no-cache",
  );
  if (options?.lastModifiedMs !== undefined) {
    res.setHeader("Last-Modified", new Date(options.lastModifiedMs).toUTCString());
  }
  setControlUiEncodingHeaders(res, extension, options?.encoding ?? "identity");
}

/** Revalidate no-cache static assets without generating entity tags. */
export function isControlUiFileUnmodified(
  req: IncomingMessage,
  lastModifiedMs: number,
  nowMs = Date.now(),
): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return false;
  }
  // Entity-tag conditions supersede dates; only "*" matches these ETag-free files.
  const ifNoneMatch = req.headers?.["if-none-match"];
  if (ifNoneMatch !== undefined) {
    return ifNoneMatch.trim() === "*";
  }
  return matchesHttpIfModifiedSince(req, lastModifiedMs, nowMs);
}

export function respondControlUiNotModified(
  res: ServerResponse,
  options: { immutable?: boolean; lastModifiedMs: number },
) {
  res.statusCode = 304;
  // A 304 repeats the caching headers of the 200 it stands in for so caches
  // refresh their freshness metadata alongside the validator.
  res.setHeader(
    "Cache-Control",
    options.immutable ? CONTROL_UI_IMMUTABLE_CACHE_CONTROL : "no-cache",
  );
  res.setHeader("Last-Modified", new Date(options.lastModifiedMs).toUTCString());
  res.setHeader("Vary", "Accept-Encoding");
  res.end();
}

export function respondHeadForControlUiFile(
  res: ServerResponse,
  filePath: string,
  options?: {
    immutable?: boolean;
    encoding?: ControlUiContentEncoding;
    contentLength?: number;
    lastModifiedMs?: number;
  },
) {
  res.statusCode = 200;
  setControlUiFileHeaders(res, filePath, options);
  if (options?.contentLength !== undefined) {
    res.setHeader("Content-Length", String(options.contentLength));
  }
  res.end();
}

function compressControlUiBody(body: Buffer, encoding: ControlUiContentEncoding): Promise<Buffer> {
  return encoding === "br"
    ? compressBrotli(body, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } })
    : compressGzip(body, { level: 6 });
}

export function serveControlUiAsset(
  res: ServerResponse,
  filePath: string,
  body: Buffer,
  options?: { immutable?: boolean; encoding?: ControlUiContentEncoding; lastModifiedMs?: number },
) {
  setControlUiFileHeaders(res, filePath, options);
  res.end(body);
}

function cachedCompressedControlUiHtml(
  body: string,
  encoding: ControlUiContentEncoding,
): Promise<Buffer> {
  const key = `${encoding}\0${body}`;
  const cached = controlUiHtmlCompressionCache.get(key);
  if (cached) {
    controlUiHtmlCompressionCache.delete(key);
    controlUiHtmlCompressionCache.set(key, cached);
    return cached;
  }

  // Index HTML is process-stable for a configured root. Keep its few rewritten
  // variants single-flight and bounded so unauthenticated requests cannot fan
  // out zlib work; large hashed assets use build-time sidecars instead.
  const compression = getOrCreatePromise(
    controlUiHtmlCompressionCache,
    key,
    () => compressControlUiBody(Buffer.from(body), encoding),
    { cacheRejections: false },
  );
  pruneMapToMaxSize(controlUiHtmlCompressionCache, CONTROL_UI_HTML_COMPRESSION_CACHE_MAX_ENTRIES);
  return compression;
}

export function respondControlUiNotAcceptable(res: ServerResponse) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Vary", "Accept-Encoding");
  respondPlainText(res, 406, "Not Acceptable");
}

export async function sendControlUiHtmlBody(
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
) {
  const encoding = resolveControlUiHtmlEncoding(req);
  if (encoding === "not-acceptable") {
    respondControlUiNotAcceptable(res);
    return;
  }
  setControlUiEncodingHeaders(res, ".html", encoding);
  res.end(encoding === "identity" ? body : await cachedCompressedControlUiHtml(body, encoding));
}
