/**
 * Agent image resize helpers.
 *
 * Downscales base64 image content for provider payload limits using the configured image processor.
 */
import type { ImageContent } from "../../llm/types.js";
import {
  convertImageToPng,
  createImageProcessor,
  isImageProcessorUnavailableError,
  type ImageProbe,
} from "../../media/image-ops.js";

interface ImageResizeOptions {
  maxWidth?: number; // Default: 2000
  maxHeight?: number; // Default: 2000
  maxBytes?: number; // Default: 4.5MB of base64 payload (below Anthropic's 5MB limit)
  jpegQuality?: number; // Default: 80
}

interface ResizedImage {
  data: string; // base64
  mimeType: string;
  originalWidth: number;
  originalHeight: number;
  width: number;
  height: number;
  wasResized: boolean;
}

type ProcessImageResult =
  | { ok: true; image: ImageContent; hints: string[] }
  | { ok: false; message: string };

const INLINE_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function baseMimeType(mimeType: string | undefined): string {
  const normalized = mimeType?.split(";")[0]?.trim().toLowerCase();
  return normalized === "image/jpg" ? "image/jpeg" : (normalized ?? "");
}

async function normalizeImageForProvider(
  image: ImageContent,
): Promise<{ image: ImageContent; convertedFrom?: string } | null> {
  const mimeType = baseMimeType(image.mimeType);
  if (INLINE_IMAGE_MIME_TYPES.has(mimeType)) {
    return { image: { ...image, mimeType } };
  }
  try {
    const output = await convertImageToPng(Buffer.from(image.data, "base64"));
    return {
      image: { type: "image", data: output.toString("base64"), mimeType: "image/png" },
      convertedFrom: mimeType || image.mimeType,
    };
  } catch {
    return null;
  }
}

/** Normalize image formats for model input, then enforce inline size limits when enabled. */
export async function processImage(
  image: ImageContent,
  options: { autoResizeImages: boolean },
): Promise<ProcessImageResult> {
  const normalized = await normalizeImageForProvider(image);
  if (!normalized) {
    return {
      ok: false,
      message: "[Image omitted: could not be converted to a supported inline image format.]",
    };
  }

  const hints: string[] = [];
  if (normalized.convertedFrom) {
    hints.push(`[Image converted from ${normalized.convertedFrom} to image/png.]`);
  }
  if (!options.autoResizeImages) {
    return { ok: true, image: normalized.image, hints };
  }

  const resized = await resizeImage(normalized.image);
  if (!resized) {
    return {
      ok: false,
      message: "[Image omitted: could not be resized below the inline image size limit.]",
    };
  }
  const dimensionNote = formatDimensionNote(resized);
  if (dimensionNote) {
    hints.push(dimensionNote);
  }
  return {
    ok: true,
    image: { type: "image", data: resized.data, mimeType: resized.mimeType },
    hints,
  };
}

// 4.5MB of base64 payload. Provides headroom below Anthropic's 5MB limit.
const DEFAULT_MAX_BYTES = 4.5 * 1024 * 1024;

const DEFAULT_OPTIONS: Required<ImageResizeOptions> = {
  maxWidth: 2000,
  maxHeight: 2000,
  maxBytes: DEFAULT_MAX_BYTES,
  jpegQuality: 80,
};

function maxBinaryBytesForBase64Budget(maxBase64Bytes: number): number {
  return Math.floor(maxBase64Bytes / 4) * 3;
}

interface EncodedCandidate {
  data: string;
  encodedSize: number;
  mimeType: string;
}

function encodeCandidate(buffer: Buffer, mimeType: string): EncodedCandidate {
  const data = buffer.toString("base64");
  return {
    data,
    encodedSize: Buffer.byteLength(data, "utf-8"),
    mimeType,
  };
}

function orientedDimensions(probe: ImageProbe): { width: number; height: number } {
  return probe.orientation && probe.orientation >= 5 && probe.orientation <= 8
    ? { width: probe.height, height: probe.width }
    : { width: probe.width, height: probe.height };
}

/**
 * Resize an image to fit within the specified max dimensions and encoded file size.
 * Returns null if the image cannot be resized below maxBytes.
 *
 * Uses Rastermill for image processing. If no Rastermill backend is available,
 * returns null.
 *
 * Strategy for staying under maxBytes:
 * 1. First resize to maxWidth/maxHeight
 * 2. Let Rastermill choose JPEG or PNG for the image transparency profile
 * 3. If still too large, search decreasing quality/compression settings
 * 4. If still too large, progressively reduce dimensions
 */
export async function resizeImage(
  img: ImageContent,
  options?: ImageResizeOptions,
): Promise<ResizedImage | null> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const inputBuffer = Buffer.from(img.data, "base64");
  const inputBase64Size = Buffer.byteLength(img.data, "utf-8");
  const processor = createImageProcessor();

  try {
    const probe = await processor.probe(inputBuffer);
    if (!probe) {
      return null;
    }
    const { width: originalWidth, height: originalHeight } = orientedDimensions(probe);
    const format = img.mimeType?.split("/")[1] ?? "png";

    // Check if already within all limits (dimensions AND encoded size)
    if (
      originalWidth <= opts.maxWidth &&
      originalHeight <= opts.maxHeight &&
      inputBase64Size < opts.maxBytes
    ) {
      return {
        data: img.data,
        mimeType: img.mimeType ?? `image/${format}`,
        originalWidth,
        originalHeight,
        width: originalWidth,
        height: originalHeight,
        wasResized: false,
      };
    }

    const qualitySteps = Array.from(new Set([opts.jpegQuality, 85, 70, 55, 40, 35]));
    const output = await processor.encode(inputBuffer, {
      format: "auto",
      limits: {
        maxWidth: opts.maxWidth,
        maxHeight: opts.maxHeight,
      },
      maxBytes: maxBinaryBytesForBase64Budget(opts.maxBytes),
      opaque: { format: "jpeg", quality: opts.jpegQuality },
      transparent: { format: "png" },
      search: {
        quality: qualitySteps,
        compressionLevel: [6, 9],
      },
    });
    const candidate = encodeCandidate(output.data, output.mimeType);
    if (candidate.encodedSize > opts.maxBytes || output.withinBudget === false) {
      return null;
    }

    return {
      data: candidate.data,
      mimeType: candidate.mimeType,
      originalWidth,
      originalHeight,
      width: output.width,
      height: output.height,
      wasResized: !output.data.equals(inputBuffer),
    };
  } catch (error) {
    if (isImageProcessorUnavailableError(error)) {
      return null;
    }
    return null;
  }
}

/**
 * Format a dimension note for resized images.
 * This helps the model understand the coordinate mapping.
 */
export function formatDimensionNote(result: ResizedImage): string | undefined {
  if (!result.wasResized) {
    return undefined;
  }

  const scale = result.originalWidth / result.width;
  return `[Image: original ${result.originalWidth}x${result.originalHeight}, displayed at ${result.width}x${result.height}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`;
}
