/**
 * Agent image resize helpers.
 *
 * Prepares image bytes for provider payload limits using the configured image processor.
 */
import type { ImageContent } from "../../llm/types.js";
import { convertImageToPng, createImageProcessor, type ImageProbe } from "../../media/image-ops.js";

interface ImageBytes {
  data: Buffer;
  mimeType: string;
}

interface ResizedImage extends ImageBytes {
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
  image: ImageBytes,
): Promise<{ image: ImageBytes; convertedFrom?: string } | null> {
  const mimeType = baseMimeType(image.mimeType);
  if (INLINE_IMAGE_MIME_TYPES.has(mimeType)) {
    return { image: { ...image, mimeType } };
  }
  try {
    const output = await convertImageToPng(image.data);
    return {
      image: { data: output, mimeType: "image/png" },
      convertedFrom: mimeType || image.mimeType,
    };
  } catch {
    return null;
  }
}

/** Normalize image formats for model input, then enforce inline size limits when enabled. */
export async function processImage(
  image: ImageBytes,
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
  let prepared = normalized.image;
  if (options.autoResizeImages) {
    const resized = await resizeImage(prepared);
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
    prepared = resized;
  }
  return {
    ok: true,
    image: { type: "image", data: prepared.data.toString("base64"), mimeType: prepared.mimeType },
    hints,
  };
}

const MAX_IMAGE_WIDTH = 2000;
const MAX_IMAGE_HEIGHT = 2000;
// 4.5MB of base64 payload leaves headroom below Anthropic's 5MB limit.
const MAX_IMAGE_BASE64_BYTES = 4.5 * 1024 * 1024;
const JPEG_QUALITY = 80;

function orientedDimensions(probe: ImageProbe): { width: number; height: number } {
  return probe.orientation && probe.orientation >= 5 && probe.orientation <= 8
    ? { width: probe.height, height: probe.width }
    : { width: probe.width, height: probe.height };
}

/**
 * Resize an image to fit within the inline dimensions and base64 payload limit.
 * Returns null if Rastermill cannot produce output within those limits.
 *
 * Uses Rastermill for image processing. If no Rastermill backend is available,
 * returns null.
 *
 * Strategy for staying under the inline limits:
 * 1. First resize to the maximum dimensions
 * 2. Let Rastermill choose JPEG or PNG for the image transparency profile
 * 3. If still too large, search decreasing quality/compression settings
 * 4. If still too large, progressively reduce dimensions
 */
async function resizeImage(img: ImageBytes): Promise<ResizedImage | null> {
  const inputBuffer = img.data;
  const inputBase64Size = 4 * Math.ceil(inputBuffer.byteLength / 3);
  const processor = createImageProcessor();

  try {
    const probe = await processor.probe(inputBuffer);
    if (!probe) {
      return null;
    }
    const { width: originalWidth, height: originalHeight } = orientedDimensions(probe);

    // Check if already within all limits (dimensions AND encoded size)
    if (
      originalWidth <= MAX_IMAGE_WIDTH &&
      originalHeight <= MAX_IMAGE_HEIGHT &&
      inputBase64Size <= MAX_IMAGE_BASE64_BYTES
    ) {
      return {
        data: img.data,
        mimeType: img.mimeType,
        originalWidth,
        originalHeight,
        width: originalWidth,
        height: originalHeight,
        wasResized: false,
      };
    }

    const qualitySteps = [JPEG_QUALITY, 85, 70, 55, 40, 35];
    const output = await processor.encode(inputBuffer, {
      format: "auto",
      limits: {
        maxWidth: MAX_IMAGE_WIDTH,
        maxHeight: MAX_IMAGE_HEIGHT,
      },
      maxBase64Bytes: MAX_IMAGE_BASE64_BYTES,
      opaque: { format: "jpeg", quality: JPEG_QUALITY },
      transparent: { format: "png" },
      search: {
        quality: qualitySteps,
        compressionLevel: [6, 9],
      },
    });
    if (output.withinBudget !== true) {
      return null;
    }

    return {
      data: output.data,
      mimeType: output.mimeType,
      originalWidth,
      originalHeight,
      width: output.width,
      height: output.height,
      wasResized: output.resized,
    };
  } catch {
    return null;
  }
}

/**
 * Format a dimension note for resized images.
 * This helps the model understand the coordinate mapping.
 */
function formatDimensionNote(result: ResizedImage): string | undefined {
  if (!result.wasResized) {
    return undefined;
  }

  const scale = result.originalWidth / result.width;
  return `[Image: original ${result.originalWidth}x${result.originalHeight}, displayed at ${result.width}x${result.height}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`;
}
