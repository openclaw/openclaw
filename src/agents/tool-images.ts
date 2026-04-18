import { createHash } from "node:crypto";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ImageContent } from "@mariozechner/pi-ai";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { canonicalizeBase64 } from "../media/base64.js";
import {
  buildImageResizeSideGrid,
  getImageMetadata,
  IMAGE_REDUCE_QUALITY_STEPS,
  resizeToJpeg,
} from "../media/image-ops.js";
import {
  DEFAULT_IMAGE_MAX_BYTES,
  DEFAULT_IMAGE_MAX_DIMENSION_PX,
  type ImageSanitizationLimits,
} from "./image-sanitization.js";

type ToolContentBlock = AgentToolResult<unknown>["content"][number];
type ImageContentBlock = Extract<ToolContentBlock, { type: "image" }>;
type TextContentBlock = Extract<ToolContentBlock, { type: "text" }>;

// Anthropic Messages API limitations (observed in OpenClaw sessions):
// - Images over ~2000px per side can fail in multi-image requests.
// - Images over 5MB are rejected by the API.
//
// To keep sessions resilient (and avoid "silent" WhatsApp non-replies), we auto-downscale
// and recompress base64 image blocks when they exceed these limits.
const MAX_IMAGE_DIMENSION_PX = DEFAULT_IMAGE_MAX_DIMENSION_PX;
const MAX_IMAGE_BYTES = DEFAULT_IMAGE_MAX_BYTES;
const log = createSubsystemLogger("agents/tool-images");

function isImageBlock(block: unknown): block is ImageContentBlock {
  if (!block || typeof block !== "object") {
    return false;
  }
  const rec = block as Record<string, unknown>;
  return rec.type === "image" && typeof rec.data === "string" && typeof rec.mimeType === "string";
}

function isTextBlock(block: unknown): block is TextContentBlock {
  if (!block || typeof block !== "object") {
    return false;
  }
  const rec = block as Record<string, unknown>;
  return rec.type === "text" && typeof rec.text === "string";
}

function inferMimeTypeFromBase64(base64: string): string | undefined {
  const trimmed = base64.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("/9j/")) {
    return "image/jpeg";
  }
  if (trimmed.startsWith("iVBOR")) {
    return "image/png";
  }
  if (trimmed.startsWith("R0lGOD")) {
    return "image/gif";
  }
  return undefined;
}

function formatBytesShort(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 1024) {
    return `${Math.max(0, Math.round(bytes))}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

function parseMediaPathFromText(text: string): string | undefined {
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("MEDIA:")) {
      continue;
    }
    const raw = trimmed.slice("MEDIA:".length).trim();
    if (!raw) {
      continue;
    }
    const backtickWrapped = raw.match(/^`([^`]+)`$/u);
    return (backtickWrapped?.[1] ?? raw).trim();
  }
  return undefined;
}

function fileNameFromPathLike(pathLike: string): string | undefined {
  const value = pathLike.trim();
  if (!value) {
    return undefined;
  }

  try {
    const url = new URL(value);
    const candidate = url.pathname.split("/").findLast(Boolean);
    return candidate && candidate.length > 0 ? candidate : undefined;
  } catch {
    // Not a URL; continue with path-like parsing.
  }

  const normalized = value.replaceAll("\\", "/");
  const candidate = normalized.split("/").findLast(Boolean);
  return candidate && candidate.length > 0 ? candidate : undefined;
}

function inferImageFileName(params: {
  block: ImageContentBlock;
  label?: string;
  mediaPathHint?: string;
}): string | undefined {
  const rec = params.block as unknown as Record<string, unknown>;
  const explicitKeys = ["fileName", "filename", "path", "url"] as const;
  for (const key of explicitKeys) {
    const raw = rec[key];
    if (typeof raw !== "string" || raw.trim().length === 0) {
      continue;
    }
    const candidate = fileNameFromPathLike(raw);
    if (candidate) {
      return candidate;
    }
  }

  if (typeof rec.name === "string" && rec.name.trim().length > 0) {
    return rec.name.trim();
  }

  if (params.mediaPathHint) {
    const candidate = fileNameFromPathLike(params.mediaPathHint);
    if (candidate) {
      return candidate;
    }
  }

  if (typeof params.label === "string" && params.label.startsWith("read:")) {
    const candidate = fileNameFromPathLike(params.label.slice("read:".length));
    if (candidate) {
      return candidate;
    }
  }

  return undefined;
}

// Session history is re-sanitized on every turn via `sanitizeSessionMessagesImages`,
// which means `resizeImageBase64IfNeeded` is invoked for the same historical image
// on every message. Both the `getImageMetadata` header read and any `resizeToJpeg`
// call are expensive (sharp image decode), so we memoize the result.
//
// Cache-key note (defends against the P1 cache-key collision flagged during
// review of #64514): the key MUST be a hash of the full base64 payload plus
// the output limits. Hashing only a prefix of the base64 collides across
// different images that share JPEG/PNG header bytes (SOI + APP0/JFIF +
// quantisation + Huffman tables routinely fill 600+ bytes before pixel data),
// which would silently substitute one image's bytes for another's in the
// session context. SHA-256 on multi-MB base64 is sub-millisecond and far
// cheaper than the sharp decode we are skipping on a cache hit.
type ResizeCacheValue = {
  base64: string;
  mimeType: string;
  resized: boolean;
  width: number | undefined;
  height: number | undefined;
  approxBytes: number;
};

const DEFAULT_RESIZE_CACHE_MAX_BYTES = 64 * 1024 * 1024; // 64 MiB

// Only bare positive integer byte counts are accepted. Human-readable suffixes
// like "64M" or "64MiB" are intentionally rejected: `Number.parseInt` silently
// truncates at the first non-digit character, so accepting them would turn
// `OPENCLAW_IMAGE_RESIZE_CACHE_MAX_BYTES=64M` into a 64-byte cap and evict
// every cache entry on insert.
function parseCacheByteLimit(): number {
  const raw = process.env.OPENCLAW_IMAGE_RESIZE_CACHE_MAX_BYTES;
  if (typeof raw !== "string") {
    return DEFAULT_RESIZE_CACHE_MAX_BYTES;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return DEFAULT_RESIZE_CACHE_MAX_BYTES;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || String(parsed) !== trimmed) {
    return DEFAULT_RESIZE_CACHE_MAX_BYTES;
  }
  return parsed;
}

let resizeCacheMaxBytes = parseCacheByteLimit();
const resizeCache = new Map<string, ResizeCacheValue>();
let resizeCacheTotalBytes = 0;
let resizeCacheHits = 0;
let resizeCacheMisses = 0;

function computeResizeCacheKey(base64: string, maxDimensionPx: number, maxBytes: number): string {
  const hash = createHash("sha256");
  hash.update(`${maxDimensionPx}:${maxBytes}:`);
  hash.update(base64);
  return hash.digest("hex");
}

function evictResizeCacheUntilBelow(limitBytes: number): void {
  if (resizeCacheTotalBytes <= limitBytes) {
    return;
  }
  // Map preserves insertion order; oldest entries live at the head.
  for (const [key, entry] of resizeCache) {
    if (resizeCacheTotalBytes <= limitBytes) {
      break;
    }
    resizeCache.delete(key);
    resizeCacheTotalBytes -= entry.approxBytes;
  }
}

function recordResizeCacheEntry(key: string, entry: ResizeCacheValue): void {
  const existing = resizeCache.get(key);
  if (existing) {
    resizeCache.delete(key);
    resizeCacheTotalBytes -= existing.approxBytes;
  }
  resizeCache.set(key, entry);
  resizeCacheTotalBytes += entry.approxBytes;
  if (resizeCacheTotalBytes > resizeCacheMaxBytes) {
    evictResizeCacheUntilBelow(resizeCacheMaxBytes);
  }
}

function lookupResizeCache(key: string): ResizeCacheValue | undefined {
  const entry = resizeCache.get(key);
  if (!entry) {
    return undefined;
  }
  // LRU touch: move to tail by delete+set so it survives evictions longer.
  resizeCache.delete(key);
  resizeCache.set(key, entry);
  return entry;
}

async function resizeImageBase64IfNeeded(params: {
  base64: string;
  mimeType: string;
  maxDimensionPx: number;
  maxBytes: number;
  label?: string;
  fileName?: string;
}): Promise<{
  base64: string;
  mimeType: string;
  resized: boolean;
  width?: number;
  height?: number;
}> {
  const cacheKey = computeResizeCacheKey(params.base64, params.maxDimensionPx, params.maxBytes);
  const cached = lookupResizeCache(cacheKey);
  if (cached) {
    resizeCacheHits += 1;
    return {
      base64: cached.base64,
      mimeType: cached.mimeType,
      resized: cached.resized,
      width: cached.width,
      height: cached.height,
    };
  }
  resizeCacheMisses += 1;

  const result = await computeResizeImageBase64(params);
  recordResizeCacheEntry(cacheKey, {
    base64: result.base64,
    mimeType: result.mimeType,
    resized: result.resized,
    width: result.width,
    height: result.height,
    // Upper bound for eviction accounting. Cheap to compute and matches the
    // dominant memory contribution of an entry (the base64 string itself).
    approxBytes: result.base64.length,
  });
  return result;
}

async function computeResizeImageBase64(params: {
  base64: string;
  mimeType: string;
  maxDimensionPx: number;
  maxBytes: number;
  label?: string;
  fileName?: string;
}): Promise<{
  base64: string;
  mimeType: string;
  resized: boolean;
  width?: number;
  height?: number;
}> {
  const buf = Buffer.from(params.base64, "base64");
  const meta = await getImageMetadata(buf);
  const width = meta?.width;
  const height = meta?.height;
  const overBytes = buf.byteLength > params.maxBytes;
  const hasDimensions = typeof width === "number" && typeof height === "number";
  const overDimensions =
    hasDimensions && (width > params.maxDimensionPx || height > params.maxDimensionPx);
  if (
    hasDimensions &&
    !overBytes &&
    width <= params.maxDimensionPx &&
    height <= params.maxDimensionPx
  ) {
    return {
      base64: params.base64,
      mimeType: params.mimeType,
      resized: false,
      width,
      height,
    };
  }

  const maxDim = hasDimensions ? Math.max(width ?? 0, height ?? 0) : params.maxDimensionPx;
  const sideStart = maxDim > 0 ? Math.min(params.maxDimensionPx, maxDim) : params.maxDimensionPx;
  const sideGrid = buildImageResizeSideGrid(params.maxDimensionPx, sideStart);

  let smallest: { buffer: Buffer; size: number } | null = null;
  for (const side of sideGrid) {
    for (const quality of IMAGE_REDUCE_QUALITY_STEPS) {
      const out = await resizeToJpeg({
        buffer: buf,
        maxSide: side,
        quality,
        withoutEnlargement: true,
      });
      if (!smallest || out.byteLength < smallest.size) {
        smallest = { buffer: out, size: out.byteLength };
      }
      if (out.byteLength <= params.maxBytes) {
        const sourcePixels =
          typeof width === "number" && typeof height === "number"
            ? `${width}x${height}px`
            : "unknown";
        const sourceWithFile = params.fileName
          ? `${params.fileName} ${sourcePixels}`
          : sourcePixels;
        const byteReductionPct =
          buf.byteLength > 0
            ? Number((((buf.byteLength - out.byteLength) / buf.byteLength) * 100).toFixed(1))
            : 0;
        log.info(
          `Image resized to fit limits: ${sourceWithFile} ${formatBytesShort(buf.byteLength)} -> ${formatBytesShort(out.byteLength)} (-${byteReductionPct}%)`,
          {
            label: params.label,
            fileName: params.fileName,
            sourceMimeType: params.mimeType,
            sourceWidth: width,
            sourceHeight: height,
            sourceBytes: buf.byteLength,
            maxBytes: params.maxBytes,
            maxDimensionPx: params.maxDimensionPx,
            triggerOverBytes: overBytes,
            triggerOverDimensions: overDimensions,
            outputMimeType: "image/jpeg",
            outputBytes: out.byteLength,
            outputQuality: quality,
            outputMaxSide: side,
            byteReductionPct,
          },
        );
        return {
          base64: out.toString("base64"),
          mimeType: "image/jpeg",
          resized: true,
          width,
          height,
        };
      }
    }
  }

  const best = smallest?.buffer ?? buf;
  const maxMb = (params.maxBytes / (1024 * 1024)).toFixed(0);
  const gotMb = (best.byteLength / (1024 * 1024)).toFixed(2);
  const sourcePixels =
    typeof width === "number" && typeof height === "number" ? `${width}x${height}px` : "unknown";
  const sourceWithFile = params.fileName ? `${params.fileName} ${sourcePixels}` : sourcePixels;
  log.warn(
    `Image resize failed to fit limits: ${sourceWithFile} best=${formatBytesShort(best.byteLength)} limit=${formatBytesShort(params.maxBytes)}`,
    {
      label: params.label,
      fileName: params.fileName,
      sourceMimeType: params.mimeType,
      sourceWidth: width,
      sourceHeight: height,
      sourceBytes: buf.byteLength,
      maxDimensionPx: params.maxDimensionPx,
      maxBytes: params.maxBytes,
      smallestCandidateBytes: best.byteLength,
      triggerOverBytes: overBytes,
      triggerOverDimensions: overDimensions,
    },
  );
  throw new Error(`Image could not be reduced below ${maxMb}MB (got ${gotMb}MB)`);
}

export async function sanitizeContentBlocksImages(
  blocks: ToolContentBlock[],
  label: string,
  opts: ImageSanitizationLimits = {},
): Promise<ToolContentBlock[]> {
  const maxDimensionPx = Math.max(opts.maxDimensionPx ?? MAX_IMAGE_DIMENSION_PX, 1);
  const maxBytes = Math.max(opts.maxBytes ?? MAX_IMAGE_BYTES, 1);
  const out: ToolContentBlock[] = [];
  let mediaPathHint: string | undefined;

  for (const block of blocks) {
    if (isTextBlock(block)) {
      const mediaPath = parseMediaPathFromText(block.text);
      if (mediaPath) {
        mediaPathHint = mediaPath;
      }
    }

    if (!isImageBlock(block)) {
      out.push(block);
      continue;
    }

    const data = block.data.trim();
    if (!data) {
      out.push({
        type: "text",
        text: `[${label}] omitted empty image payload`,
      } satisfies TextContentBlock);
      continue;
    }
    const canonicalData = canonicalizeBase64(data);
    if (!canonicalData) {
      out.push({
        type: "text",
        text: `[${label}] omitted image payload: invalid base64`,
      } satisfies TextContentBlock);
      continue;
    }

    try {
      const inferredMimeType = inferMimeTypeFromBase64(canonicalData);
      const mimeType = inferredMimeType ?? block.mimeType;
      const fileName = inferImageFileName({ block, label, mediaPathHint });
      const resized = await resizeImageBase64IfNeeded({
        base64: canonicalData,
        mimeType,
        maxDimensionPx,
        maxBytes,
        label,
        fileName,
      });
      out.push({
        ...block,
        data: resized.base64,
        mimeType: resized.resized ? resized.mimeType : mimeType,
      });
    } catch (err) {
      out.push({
        type: "text",
        text: `[${label}] omitted image payload: ${String(err)}`,
      } satisfies TextContentBlock);
    }
  }

  return out;
}

export async function sanitizeImageBlocks(
  images: ImageContent[],
  label: string,
  opts: ImageSanitizationLimits = {},
): Promise<{ images: ImageContent[]; dropped: number }> {
  if (images.length === 0) {
    return { images, dropped: 0 };
  }
  const sanitized = await sanitizeContentBlocksImages(images as ToolContentBlock[], label, opts);
  const next = sanitized.filter(isImageBlock);
  return { images: next, dropped: Math.max(0, images.length - next.length) };
}

export async function sanitizeToolResultImages(
  result: AgentToolResult<unknown>,
  label: string,
  opts: ImageSanitizationLimits = {},
): Promise<AgentToolResult<unknown>> {
  const content = Array.isArray(result.content) ? result.content : [];
  if (!content.some((b) => isImageBlock(b) || isTextBlock(b))) {
    return result;
  }

  const next = await sanitizeContentBlocksImages(content, label, opts);
  return { ...result, content: next };
}

export const __testing = {
  resetResizeCache(): void {
    resizeCache.clear();
    resizeCacheTotalBytes = 0;
    resizeCacheHits = 0;
    resizeCacheMisses = 0;
    resizeCacheMaxBytes = parseCacheByteLimit();
  },
  setResizeCacheMaxBytes(value: number): void {
    resizeCacheMaxBytes = Math.max(1, Math.floor(value));
    evictResizeCacheUntilBelow(resizeCacheMaxBytes);
  },
  getResizeCacheStats(): {
    entryCount: number;
    totalBytes: number;
    maxBytes: number;
    hits: number;
    misses: number;
  } {
    return {
      entryCount: resizeCache.size,
      totalBytes: resizeCacheTotalBytes,
      maxBytes: resizeCacheMaxBytes,
      hits: resizeCacheHits,
      misses: resizeCacheMisses,
    };
  },
  // Exposed so tests can directly assert the key-collision safety property
  // called out on PR #64514: two inputs that share a long leading prefix
  // must still produce distinct keys. Going through `sanitizeContentBlocksImages`
  // alone cannot prove this because the cache is only populated on the
  // success path, and two different payloads can silently converge on the
  // same stats with a colliding key.
  computeResizeCacheKey,
};
