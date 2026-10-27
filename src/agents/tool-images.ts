import { createHash } from "node:crypto";
import { canonicalizeBase64, estimateBase64DecodedBytes } from "@openclaw/media-core/base64";
import { formatByteSize, resolveIntegerOption } from "@openclaw/normalization-core";
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

type PreparedImage = {
  data: string;
  mimeType: string;
  canonicalData?: string;
  omission?: string;
  digest?: string;
};
// Keep byte validation with the block's lifetime, not a second content-addressed
// payload store. Mutable blocks invalidate on either input; decode outcomes and
// backend retries remain owned by the bounded cache above.
const preparedImages = new WeakMap<ImageContentBlock, PreparedImage>();

function prepareImage(block: ImageContentBlock): PreparedImage {
  const cached = preparedImages.get(block);
  if (cached?.data === block.data && cached.mimeType === block.mimeType) {
    return cached;
  }
  const prepared: PreparedImage = { data: block.data, mimeType: block.mimeType };
  // Enforce the raw input ceiling before trim/canonicalize/decode allocations.
  if (estimateBase64DecodedBytes(block.data) > MAX_IMAGE_INPUT_BYTES) {
    prepared.omission = `omitted image payload: image exceeds input size limit (${formatBytesShort(MAX_IMAGE_INPUT_BYTES)})`;
  } else {
    const data = block.data.trim();
    const canonicalData = data ? canonicalizeBase64(data) : undefined;
    if (!canonicalData) {
      prepared.omission = data
        ? "omitted image payload: invalid base64"
        : "omitted empty image payload";
    } else if (canonicalData !== block.data) {
      // Already-canonical input retains only the original string reference.
      prepared.canonicalData = canonicalData;
    }
  }
  preparedImages.set(block, prepared);
  return prepared;
}

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
): boolean {
  return (
    metadata !== null &&
    metadata.width > 0 &&
    metadata.height > 0 &&
    buffer.byteLength <= maxBytes &&
    metadata.width <= maxDimensionPx &&
    metadata.height <= maxDimensionPx &&
    metadata.width * metadata.height <= MAX_IMAGE_INPUT_PIXELS
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

  if (params.label?.startsWith("read:")) {
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

    const prepared = prepareImage(block);
    if (prepared.omission) {
      omit(prepared.omission);
      continue;
    }
    const canonicalData = prepared.canonicalData ?? prepared.data;

    try {
      const inferredMimeType = inferMimeTypeFromBase64(canonicalData);
      const mimeType = inferredMimeType ?? block.mimeType;
      const fileName = inferImageFileName({ block, label });
      const verifyDecodability = opts.verifyDecodability;
      const resized = await (async (): Promise<{ base64: string; mimeType: string }> => {
        // Only callers sanitizing persisted bytes verify them, and only those bytes repeat.
        const cacheKey = verifyDecodability
          ? `${(prepared.digest ??= createHash("sha256").update(canonicalData).digest("base64url"))}:${maxDimensionPx}:${maxBytes}`
          : undefined;
        const cached = cacheKey === undefined ? undefined : verifiedImageOutcomes.get(cacheKey);
        if (cached !== undefined) {
          return cached === null
            ? { base64: canonicalData, mimeType }
            : { base64: cached, mimeType: "image/jpeg" };
        }
        const buf = Buffer.from(canonicalData, "base64");
        const meta = readImageMetadataFromHeader(buf) ?? (await getImageMetadata(buf));
        const overBytes = buf.byteLength > maxBytes;
        const overDimensions =
          meta !== null && (meta.width > maxDimensionPx || meta.height > maxDimensionPx);
        if (imageWithinLimits(buf, meta, maxDimensionPx, maxBytes)) {
          // An unavailable backend passes images through unverified; never record that.
          if (cacheKey !== undefined && (await verifyImageDecodability(buf))) {
            verifiedImageOutcomes.set(cacheKey, null);
          }
          return {
            base64: canonicalData,
            mimeType,
          };
        }

        const maxDim = meta ? Math.max(meta.width, meta.height) : maxDimensionPx;
        const sideStart = maxDim > 0 ? Math.min(maxDimensionPx, maxDim) : maxDimensionPx;
        const sideGrid = buildImageResizeSideGrid(maxDimensionPx, sideStart);

        const sourcePixels = meta ? `${meta.width}x${meta.height}px` : "unknown";
        const sourceWithFile = fileName ? `${fileName} ${sourcePixels}` : sourcePixels;
        const sourceDetails = {
          label,
          fileName,
          sourceMimeType: mimeType,
          sourceWidth: meta?.width,
          sourceHeight: meta?.height,
          sourceBytes: buf.byteLength,
        };
        let smallestSize: number | undefined;
        for (const side of sideGrid) {
          for (const quality of IMAGE_REDUCE_QUALITY_STEPS) {
            const candidateBuffer = await resizeToJpeg({
              buffer: buf,
              maxSide: side,
              quality,
              withoutEnlargement: true,
            });
            if (smallestSize === undefined || candidateBuffer.byteLength < smallestSize) {
              smallestSize = candidateBuffer.byteLength;
            }
            if (candidateBuffer.byteLength <= maxBytes) {
              const byteReductionPct =
                buf.byteLength > 0
                  ? Number(
                      (
                        ((buf.byteLength - candidateBuffer.byteLength) / buf.byteLength) *
                        100
                      ).toFixed(1),
                    )
                  : 0;
              log.info(
                `Image resized to fit limits: ${sourceWithFile} ${formatBytesShort(buf.byteLength)} -> ${formatBytesShort(candidateBuffer.byteLength)} (${byteReductionPct < 0 ? "+" : ""}${-byteReductionPct}%)`,
                {
                  ...sourceDetails,
                  maxBytes,
                  maxDimensionPx,
                  triggerOverBytes: overBytes,
                  triggerOverDimensions: overDimensions,
                  outputMimeType: "image/jpeg",
                  outputBytes: candidateBuffer.byteLength,
                  outputQuality: quality,
                  outputMaxSide: side,
                  byteReductionPct,
                },
              );
              const replacementBase64 = candidateBuffer.toString("base64");
              if (cacheKey !== undefined) {
                verifiedImageOutcomes.set(cacheKey, replacementBase64);
              }
              return { base64: replacementBase64, mimeType: "image/jpeg" };
            }
          }
        }

        const bestSize = smallestSize ?? buf.byteLength;
        log.warn(
          `Image resize failed to fit limits: ${sourceWithFile} best=${formatBytesShort(bestSize)} limit=${formatBytesShort(maxBytes)}`,
          {
            ...sourceDetails,
            maxDimensionPx,
            maxBytes,
            smallestCandidateBytes: bestSize,
            triggerOverBytes: overBytes,
            triggerOverDimensions: overDimensions,
          },
        );
        throw new Error(
          `Image could not be reduced below ${formatBytesShort(maxBytes)} (got ${formatBytesShort(bestSize)})`,
        );
      })();
      const sanitized = {
        ...block,
        data: resized.base64,
        mimeType: resized.mimeType,
      };
      if (resized.base64 === canonicalData) {
        preparedImages.set(sanitized, {
          data: resized.base64,
          mimeType: resized.mimeType,
          digest: prepared.digest,
        });
      }
      out.push(sanitized);
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
  const content = result.content;
  if (!content.some((block) => isImageTypeBlock(block) || isTextContentBlock(block))) {
    return result;
  }

  const next = await sanitizeContentBlocksImages(content, label, opts);
  return { ...result, content: next };
}
