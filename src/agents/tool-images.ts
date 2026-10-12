import { createHash } from "node:crypto";
import { canonicalizeBase64, estimateBase64DecodedBytes } from "@openclaw/media-core/base64";
import { formatByteSize, resolveIntegerOption } from "@openclaw/normalization-core";
import { toErrorObject } from "../infra/errors.js";
import { LruCache } from "../infra/lru-cache.js";
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
import { isTextContentBlock } from "./content-blocks.js";
import {
  DEFAULT_IMAGE_MAX_BYTES,
  DEFAULT_IMAGE_MAX_DIMENSION_PX,
  type ImageSanitizationLimits,
} from "./image-sanitization.js";
import type { AgentToolResult } from "./runtime/index.js";

type ToolContentBlock = AgentToolResult<unknown>["content"][number];
type ImageContentBlock = Extract<ToolContentBlock, { type: "image" }>;

type ToolImageSanitizationOptions = ImageSanitizationLimits & {
  verifyDecodability?: boolean;
};

// Anthropic Messages API rejects oversized images; sanitize here so replayed
// tool outputs do not break later turns or silent channel replies.
// Hard cap on decoded input bytes before Buffer.from/resizer allocation. A
// conservative limit well below demonstrated OOM thresholds, leaving headroom
// for canonicalization, decode, and image-processing allocations while still
// permitting legitimate tool-output images.
const MAX_IMAGE_INPUT_BYTES = 10 * 1024 * 1024;
const log = createSubsystemLogger("agents/tool-images");
// Replay re-sanitizes persisted images every attempt without rewriting them. A decoded
// outcome depends only on the bytes and limits, so content-addressed entries never go
// stale; byte-bounded LRU eviction is their only lifecycle. `null` means verified as-is.
const verifiedImageOutcomes = new LruCache<string | null>(4096, {
  maxBytes: 16 * 1024 * 1024,
  sizeOf: (replacement) => 128 + (replacement?.length ?? 0),
});

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

function inferMimeTypeFromBase64(base64: string): string | undefined {
  if (base64.startsWith("/9j/")) {
    return "image/jpeg";
  }
  if (base64.startsWith("iVBOR")) {
    return "image/png";
  }
  if (base64.startsWith("R0lGOD")) {
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
  return formatByteSize(bytes, {
    style: "legacy-binary",
    maxUnit: "mega",
    separator: "",
    fractionDigits: (_value, unit) => (unit === "mega" ? 2 : unit === "kilo" ? 1 : 0),
  });
}

function fileNameFromPathLike(pathLike: string): string | undefined {
  const value = pathLike.trim();
  if (!value) {
    return undefined;
  }

  const url = URL.parse(value);
  if (url) {
    return url.pathname.split("/").findLast(Boolean);
  }

  return value.replaceAll("\\", "/").split("/").findLast(Boolean);
}

function inferImageFileName(params: {
  block: ImageContentBlock;
  label?: string;
}): string | undefined {
  const explicitKeys = ["fileName", "filename", "path", "url"] as const;
  for (const key of explicitKeys) {
    const raw = Reflect.get(params.block, key);
    if (typeof raw !== "string") {
      continue;
    }
    const candidate = fileNameFromPathLike(raw);
    if (candidate) {
      return candidate;
    }
  }

  const name = Reflect.get(params.block, "name");
  if (typeof name === "string" && name.trim().length > 0) {
    return name.trim();
  }

  if (typeof params.label === "string" && params.label.startsWith("read:")) {
    return fileNameFromPathLike(params.label.slice("read:".length));
  }
  return undefined;
}

async function verifyImageDecodability(buffer: Buffer): Promise<boolean> {
  try {
    // Rastermill probes only headers; discard a tiny encode to verify full decodability.
    await resizeToJpeg({ buffer, maxSide: 1, quality: 1, withoutEnlargement: true });
    return true;
  } catch (err) {
    if (!isImageProcessorUnavailableError(err)) {
      throw err;
    }
    return false;
  }
}

async function resizeImageBase64IfNeeded(params: {
  base64: string;
  mimeType: string;
  maxDimensionPx: number;
  maxBytes: number;
  label?: string;
  fileName?: string;
  verifyDecodability?: boolean;
}): Promise<{
  base64: string;
  mimeType: string;
}> {
  // Only callers sanitizing persisted bytes verify them, and only those bytes repeat.
  const cacheKey = params.verifyDecodability
    ? `${createHash("sha256").update(params.base64).digest("base64url")}:${params.maxDimensionPx}:${params.maxBytes}`
    : undefined;
  const cached = cacheKey === undefined ? undefined : verifiedImageOutcomes.get(cacheKey);
  if (cached !== undefined) {
    return cached === null
      ? { base64: params.base64, mimeType: params.mimeType }
      : { base64: cached, mimeType: "image/jpeg" };
  }
  const buf = Buffer.from(params.base64, "base64");
  const meta = readImageMetadataFromHeader(buf) ?? (await getImageMetadata(buf));
  const width = meta?.width;
  const height = meta?.height;
  const overBytes = buf.byteLength > params.maxBytes;
  const hasDimensions = typeof width === "number" && typeof height === "number";
  const overDimensions =
    hasDimensions && (width > params.maxDimensionPx || height > params.maxDimensionPx);
  if (imageWithinLimits(buf, meta, params.maxDimensionPx, params.maxBytes)) {
    // An unavailable backend passes images through unverified; never record that.
    if (cacheKey !== undefined && (await verifyImageDecodability(buf))) {
      verifiedImageOutcomes.set(cacheKey, null);
    }
    return {
      base64: params.base64,
      mimeType: params.mimeType,
    };
  }

  const maxDim = hasDimensions ? Math.max(width ?? 0, height ?? 0) : params.maxDimensionPx;
  const sideStart = maxDim > 0 ? Math.min(params.maxDimensionPx, maxDim) : params.maxDimensionPx;
  const sideGrid = buildImageResizeSideGrid(params.maxDimensionPx, sideStart);

  const sourcePixels = hasDimensions ? `${width}x${height}px` : "unknown";
  const sourceWithFile = params.fileName ? `${params.fileName} ${sourcePixels}` : sourcePixels;
  const sourceDetails = {
    label: params.label,
    fileName: params.fileName,
    sourceMimeType: params.mimeType,
    sourceWidth: width,
    sourceHeight: height,
    sourceBytes: buf.byteLength,
  };
  let smallestSize: number | undefined;
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
          throw toErrorObject(err, "Non-Error thrown");
        }
        throw err;
      }
      if (smallestSize === undefined || out.byteLength < smallestSize) {
        smallestSize = out.byteLength;
      }
      if (out.byteLength <= params.maxBytes) {
        const byteReductionPct =
          buf.byteLength > 0
            ? Number((((buf.byteLength - out.byteLength) / buf.byteLength) * 100).toFixed(1))
            : 0;
        log.info(
          `Image resized to fit limits: ${sourceWithFile} ${formatBytesShort(buf.byteLength)} -> ${formatBytesShort(out.byteLength)} (${byteReductionPct < 0 ? "+" : ""}${-byteReductionPct}%)`,
          {
            ...sourceDetails,
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
        const base64 = out.toString("base64");
        if (cacheKey !== undefined) {
          verifiedImageOutcomes.set(cacheKey, base64);
        }
        return { base64, mimeType: "image/jpeg" };
      }
    }
  }

  const bestSize = smallestSize ?? buf.byteLength;
  log.warn(
    `Image resize failed to fit limits: ${sourceWithFile} best=${formatBytesShort(bestSize)} limit=${formatBytesShort(params.maxBytes)}`,
    {
      ...sourceDetails,
      maxDimensionPx: params.maxDimensionPx,
      maxBytes: params.maxBytes,
      smallestCandidateBytes: bestSize,
      triggerOverBytes: overBytes,
      triggerOverDimensions: overDimensions,
    },
  );
  throw new Error(
    `Image could not be reduced below ${formatBytesShort(params.maxBytes)} (got ${formatBytesShort(bestSize)})`,
  );
}

export async function sanitizeContentBlocksImages(
  blocks: ToolContentBlock[],
  label: string,
  opts: ToolImageSanitizationOptions = {},
): Promise<ToolContentBlock[]> {
  const maxDimensionPx = resolveIntegerOption(opts.maxDimensionPx, DEFAULT_IMAGE_MAX_DIMENSION_PX, {
    min: 1,
  });
  const maxBytes = resolveIntegerOption(opts.maxBytes, DEFAULT_IMAGE_MAX_BYTES, { min: 1 });
  const out: ToolContentBlock[] = [];
  const omit = (reason: string) => out.push({ type: "text", text: `[${label}] ${reason}` });
  for (const block of blocks) {
    if (!isImageBlock(block)) {
      if (isImageTypeBlock(block)) {
        omit("omitted image payload: missing data or mimeType");
        continue;
      }
      out.push(block);
      continue;
    }

    // Estimate decoded bytes on the raw payload before trim/canonicalize/decode
    // so pathological multi-GB base64 cannot force a transient large allocation.
    // maxBytes is the post-decode resize target; MAX_IMAGE_INPUT_BYTES is a
    // conservative pre-decode ceiling (10 MiB) far below the 25MP/100MB
    // processing headroom, so legitimate tool images still decode and resize.
    if (estimateBase64DecodedBytes(block.data) > MAX_IMAGE_INPUT_BYTES) {
      omit(
        `omitted image payload: image exceeds input size limit (${formatBytesShort(MAX_IMAGE_INPUT_BYTES)})`,
      );
      continue;
    }

    const data = block.data.trim();
    if (!data) {
      omit("omitted empty image payload");
      continue;
    }
    const canonicalData = canonicalizeBase64(data);
    if (!canonicalData) {
      omit("omitted image payload: invalid base64");
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
        verifyDecodability: opts.verifyDecodability,
      });
      out.push({
        ...block,
        data: resized.base64,
        mimeType: resized.mimeType,
      });
    } catch (err) {
      omit(`omitted image payload: ${String(err)}`);
    }
  }

  return out;
}

export async function sanitizeImageBlocks(
  images: ImageContent[],
  label: string,
  opts: ToolImageSanitizationOptions = {},
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
  if (!content.some((block) => isImageTypeBlock(block) || isTextContentBlock(block))) {
    return result;
  }

  const next = await sanitizeContentBlocksImages(content, label, opts);
  return { ...result, content: next };
}
