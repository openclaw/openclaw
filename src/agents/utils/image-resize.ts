import type { ImageContent } from "../../llm/types.js";
import { convertImageToPng, createImageProcessor, type ImageProbe } from "../../media/image-ops.js";

interface ImageBytes {
  data: Buffer;
  mimeType: string;
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
    if (resized.hint) {
      hints.push(resized.hint);
    }
    prepared = resized.image;
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

/** Returns null when the image processor cannot meet the inline dimensions and payload limit. */
async function resizeImage(img: ImageBytes): Promise<{ image: ImageBytes; hint?: string } | null> {
  const inputBuffer = img.data;
  const inputBase64Size = 4 * Math.ceil(inputBuffer.byteLength / 3);
  const processor = createImageProcessor();

  try {
    const probe = await processor.probe(inputBuffer);
    if (!probe) {
      return null;
    }
    const { width: originalWidth, height: originalHeight } = orientedDimensions(probe);

    if (
      originalWidth <= MAX_IMAGE_WIDTH &&
      originalHeight <= MAX_IMAGE_HEIGHT &&
      inputBase64Size <= MAX_IMAGE_BASE64_BYTES
    ) {
      return { image: img };
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
      image: output,
      hint: output.resized
        ? `[Image: original ${originalWidth}x${originalHeight}, displayed at ${output.width}x${output.height}. Multiply coordinates by ${(originalWidth / output.width).toFixed(2)} to map to original image.]`
        : undefined,
    };
  } catch {
    return null;
  }
}
