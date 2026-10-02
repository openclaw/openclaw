import {
  isRastermillUnavailableError,
  RastermillUnavailableError,
  readImageProbeFromHeader,
  type EncodedImage,
  type EncodeOptions,
  type ImageProbe,
  type ImageMetadata,
} from "rastermill";
import { MAX_IMAGE_INPUT_PIXELS } from "./image-processor-config.js";
import { convertBmpToPngWithWorker, createImageProcessor } from "./image-processor.js";

export { MAX_IMAGE_INPUT_PIXELS } from "./image-processor-config.js";
export { createImageProcessor } from "./image-processor.js";
export { readImageProbeFromHeader };

export type { ImageMetadata, ImageProbe };

/** OpenClaw-facing image backend availability error, preserving the failed operation and causes. */
class ImageProcessorUnavailableError extends Error {
  readonly code = "IMAGE_PROCESSOR_UNAVAILABLE";
  readonly operation: string;
  readonly causes: unknown[];

  constructor(operation: string, message?: string, causes: unknown[] = []) {
    super(message ?? `Image processor unavailable for ${operation}`, {
      cause: causes.find((cause): cause is Error => cause instanceof Error),
    });
    this.name = "ImageProcessorUnavailableError";
    this.operation = operation;
    this.causes = causes;
  }
}

type ResizeToJpegParams = {
  buffer: Buffer;
  maxSide: number;
  quality: number;
  withoutEnlargement?: boolean;
};

export const IMAGE_REDUCE_QUALITY_STEPS = [85, 75, 65, 55, 45, 35] as const;

export function isImageProcessorUnavailableError(err: unknown): boolean {
  return err instanceof ImageProcessorUnavailableError || isRastermillUnavailableError(err);
}

/** Builds a descending, de-duplicated max-side search grid for iterative image resizing. */
export function buildImageResizeSideGrid(maxSide: number, sideStart: number): number[] {
  return [sideStart, 1800, 1600, 1400, 1200, 1000, 800]
    .map((value) => Math.min(maxSide, value))
    .filter((value, idx, arr) => value > 0 && arr.indexOf(value) === idx)
    .toSorted((a, b) => b - a);
}

function resolveDisplayImageMetadata(probe: ImageProbe | null): ImageMetadata | null {
  if (!probe) {
    return null;
  }
  // Rastermill reports encoded axes; orientations 5-8 swap the displayed axes.
  if (probe.orientation && probe.orientation >= 5 && probe.orientation <= 8) {
    return { width: probe.height, height: probe.width };
  }
  return { width: probe.width, height: probe.height };
}

/** Reads display dimensions from image header bytes without invoking a full image decode. */
export function readImageMetadataFromHeader(buffer: Buffer): ImageMetadata | null {
  return resolveDisplayImageMetadata(readImageProbeFromHeader(buffer));
}

/** Detects animated WebP before a single-frame image transform can discard its frames. */
export function isAnimatedWebpBuffer(buffer: Buffer): boolean {
  // Rastermill's probe has no animation flag. RFC 9649 §2.7 defines this VP8X bit.
  return (
    buffer.length >= 30 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP" &&
    buffer.toString("ascii", 12, 16) === "VP8X" &&
    buffer.readUInt32LE(16) >= 10 &&
    buffer.readUInt32LE(16) <= buffer.length - 20 &&
    (buffer.readUInt8(20) & 0x02) !== 0
  );
}

/** Confirm PNG is still without treating a truncated or capped scan as proof. */
export function isStillPngBuffer(buffer: Buffer): boolean {
  if (readImageProbeFromHeader(buffer)?.format !== "png") {
    return false;
  }
  let offset = 8;
  for (let chunks = 0; chunks < 512 && offset + 12 <= buffer.length; chunks += 1) {
    const end = offset + 12 + buffer.readUInt32BE(offset);
    if (end > buffer.length) {
      return false;
    }
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    if (type === "acTL" || type === "IEND") {
      return false;
    }
    if (type === "IDAT") {
      return true;
    }
    offset = end;
  }
  return false;
}

/** Fully probes display dimensions through Rastermill when header-only metadata is insufficient. */
export async function getImageMetadata(buffer: Buffer): Promise<ImageMetadata | null> {
  return resolveDisplayImageMetadata(await createImageProcessor().probe(buffer));
}

/** Resizes or encodes image bytes as JPEG through the shared image processor. */
export async function resizeToJpeg(params: ResizeToJpegParams): Promise<Buffer> {
  return (
    await encodeImage(
      params.buffer,
      {
        format: "jpeg",
        resize: {
          maxSide: params.maxSide,
          enlarge: params.withoutEnlargement === false,
        },
        quality: params.quality,
      },
      "resizeToJpeg",
    )
  ).data;
}

async function encodeImage(
  buffer: Buffer,
  options: EncodeOptions,
  operation: string,
): Promise<EncodedImage> {
  try {
    return await createImageProcessor().encode(buffer, options);
  } catch (error) {
    if (error instanceof RastermillUnavailableError) {
      throw new ImageProcessorUnavailableError(operation, error.message, error.causes);
    }
    throw error;
  }
}

export async function convertImageToJpeg(buffer: Buffer): Promise<Buffer> {
  return (await encodeImage(buffer, { format: "jpeg" }, "convertImageToJpeg")).data;
}

export async function convertHeicToJpeg(buffer: Buffer): Promise<Buffer> {
  return (await encodeImage(buffer, { format: "jpeg" }, "convertHeicToJpeg")).data;
}

/** Converts image bytes to PNG, including BMP fallback unsupported by Rastermill's Photon gate. */
export async function convertImageToPng(buffer: Buffer): Promise<Buffer> {
  try {
    return (await createImageProcessor().encode(buffer, { format: "png" })).data;
  } catch (error) {
    const probe = readImageProbeFromHeader(buffer);
    const withinPixelLimit =
      probe &&
      probe.format === "bmp" &&
      probe.width > 0 &&
      probe.height > 0 &&
      probe.width <= MAX_IMAGE_INPUT_PIXELS / probe.height;
    if (!withinPixelLimit) {
      throw error;
    }

    try {
      return await convertBmpToPngWithWorker(buffer);
    } catch {
      throw error;
    }
  }
}

/** Optimizes PNG bytes under a target size and returns the chosen search parameters. */
export async function optimizeImageToPng(
  buffer: Buffer,
  maxBytes: number,
  options?: { sides?: readonly number[] },
): Promise<{
  buffer: Buffer;
  optimizedSize: number;
  resizeSide: number;
  compressionLevel: number;
}> {
  const out = await encodeImage(
    buffer,
    {
      format: "png",
      maxBytes,
      search: options?.sides === undefined ? {} : { maxSide: options.sides },
    },
    "optimizeImageToPng",
  );
  return {
    buffer: out.data,
    optimizedSize: out.bytes,
    resizeSide: out.chosen.maxSide ?? out.width,
    compressionLevel: out.chosen.compressionLevel ?? 6,
  };
}
