/**
 * Tool image output sanitizer.
 *
 * Downscales and recompresses oversized base64 image blocks before provider replay.
 */
import { createHash } from "node:crypto";
import { canonicalizeBase64 } from "@openclaw/media-core/base64";
import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";
import type { ImageContent } from "../llm/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  buildImageResizeSideGrid,
  getImageMetadata,
  IMAGE_REDUCE_QUALITY_STEPS,
  isImageProcessorUnavailableError,
  MAX_IMAGE_INPUT_PIXELS,
  readImageMetadataFromHeader,
  resizeToJpeg,
  type ImageMetadata,
} from "../media/media-services.js";
import {
  DEFAULT_IMAGE_MAX_BYTES,
  DEFAULT_IMAGE_MAX_DIMENSION_PX,
  type ImageSanitizationLimits,
} from "./image-sanitization.js";
import type { AgentToolResult } from "./runtime/index.js";

type ToolContentBlock = AgentToolResult<unknown>["content"][number];
type ImageContentBlock = Extract<ToolContentBlock, { type: "image" }>;
type TextContentBlock = Extract<ToolContentBlock, { type: "text" }>;

// Anthropic Messages API rejects oversized images; sanitize here so replayed
// tool outputs do not break later turns or silent channel replies.
const MAX_IMAGE_DIMENSION_PX = DEFAULT_IMAGE_MAX_DIMENSION_PX;
const MAX_IMAGE_BYTES = DEFAULT_IMAGE_MAX_BYTES;
const log = createSubsystemLogger("agents/tool-images");

function isImageTypeBlock(block: unknown): block is Record<string, unknown> & { type: "image" } {
  return (
    Boolean(block) && typeof block === "object" && (block as { type?: unknown }).type === "image"
  );
}

function isImageBlock(block: unknown): block is ImageContentBlock {
  if (!isImageTypeBlock(block)) {
    return false;
  }
  return typeof block.data === "string" && typeof block.mimeType === "string";
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

function imageWithinLimits(
  buffer: Buffer,
  metadata: ImageMetadata | null,
  maxDimensionPx: number,
  maxBytes: number,
): metadata is ImageMetadata {
  const width = metadata?.width;
  const height = metadata?.height;
  return (
    typeof width === "number" &&
    typeof height === "number" &&
    width > 0 &&
    height > 0 &&
    buffer.byteLength <= maxBytes &&
    width <= maxDimensionPx &&
    height <= maxDimensionPx &&
    width * height <= MAX_IMAGE_INPUT_PIXELS
  );
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
// on every message. Both the header/metadata reads and any `resizeToJpeg` call are
// expensive image work, so memoize the result behind a small byte-bounded LRU.
//
// Cache-key note: the key must hash the full base64 payload plus output limits.
// Prefix hashing can collide across different images that share format/header
// bytes, silently substituting one image's bytes for another in session context.
type ResizeCacheValue = {
  base64: string;
  mimeType: string;
  resized: boolean;
  width: number | undefined;
  height: number | undefined;
  approxBytes: number;
};

const RESIZE_CACHE_MAX_BYTES = 64 * 1024 * 1024; // 64 MiB
const resizeCache = new Map<string, ResizeCacheValue>();
let resizeCacheMaxBytes = RESIZE_CACHE_MAX_BYTES;
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
      // For a no-op cache hit (no resize happened), preserve the caller's
      // declared mimeType. The same bytes can legitimately arrive with
      // different declared MIME types when the header is not canonicalized by
      // `inferMimeTypeFromBase64` (e.g. WebP/HEIC). Resized hits are always
      // transformation-derived JPEGs, so the cached MIME is correct there.
      mimeType: cached.resized ? cached.mimeType : params.mimeType,
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
  const headerMeta = readImageMetadataFromHeader(buf);
  if (imageWithinLimits(buf, headerMeta, params.maxDimensionPx, params.maxBytes)) {
    return {
      base64: params.base64,
      mimeType: params.mimeType,
      resized: false,
      width: headerMeta.width,
      height: headerMeta.height,
    };
  }
  const meta = headerMeta ?? (await getImageMetadata(buf));
  const width = meta?.width;
  const height = meta?.height;
  const overBytes = buf.byteLength > params.maxBytes;
  const hasDimensions = typeof width === "number" && typeof height === "number";
  const overDimensions =
    hasDimensions && (width > params.maxDimensionPx || height > params.maxDimensionPx);
  if (imageWithinLimits(buf, meta, params.maxDimensionPx, params.maxBytes)) {
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
  let processorUnavailableError: unknown;
  for (const side of sideGrid) {
    for (const quality of IMAGE_REDUCE_QUALITY_STEPS) {
      let out: Buffer;
      try {
        out = await resizeToJpeg({
          buffer: buf,
          maxSide: side,
          quality,
          withoutEnlargement: true,
        });
      } catch (err) {
        if (isImageProcessorUnavailableError(err)) {
          processorUnavailableError = err;
          break;
        }
        throw err;
      }
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
    if (processorUnavailableError) {
      break;
    }
  }

  if (processorUnavailableError) {
    throw toLintErrorObject(processorUnavailableError, "Non-Error thrown");
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
  const maxDimensionPx = resolveIntegerOption(opts.maxDimensionPx, MAX_IMAGE_DIMENSION_PX, {
    min: 1,
  });
  const maxBytes = resolveIntegerOption(opts.maxBytes, MAX_IMAGE_BYTES, { min: 1 });
  const out: ToolContentBlock[] = [];
  for (const block of blocks) {
    if (!isImageBlock(block)) {
      if (isImageTypeBlock(block)) {
        out.push({
          type: "text",
          text: `[${label}] omitted image payload: missing data or mimeType`,
        } satisfies TextContentBlock);
        continue;
      }
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
      const fileName = inferImageFileName({ block, label });
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
  if (!content.some((block) => isImageTypeBlock(block) || isTextBlock(block))) {
    return result;
  }

  const next = await sanitizeContentBlocksImages(content, label, opts);
  return { ...result, content: next };
}

export const testing = {
  resetResizeCache(): void {
    resizeCache.clear();
    resizeCacheMaxBytes = RESIZE_CACHE_MAX_BYTES;
    resizeCacheTotalBytes = 0;
    resizeCacheHits = 0;
    resizeCacheMisses = 0;
  },
  setResizeCacheMaxBytesForTests(value: number): void {
    // Test-only seam: the production cap is intentionally fixed so this PR does
    // not add a new operator/environment configuration surface.
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
  computeResizeCacheKey,
  resizeImageBase64IfNeeded,
};
export { testing as __testing };

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
