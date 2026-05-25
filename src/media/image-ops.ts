import { randomUUID } from "node:crypto";
import {
  createRastermill,
  isRastermillUnavailableError,
  RastermillUnavailableError,
  readImageMetadataFromHeader as readRastermillImageMetadataFromHeader,
  readImageProbeFromHeader as readRastermillImageProbeFromHeader,
  type ImageMetadata,
} from "rastermill";
import { resolveSystemBin } from "../infra/resolve-system-bin.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";

export type { ImageMetadata };

export type ResizeToJpegParams = {
  buffer: Buffer;
  maxSide: number;
  quality: number;
  withoutEnlargement?: boolean;
};

export type ResizeToPngParams = {
  buffer: Buffer;
  maxSide: number;
  compressionLevel?: number;
  withoutEnlargement?: boolean;
};

export const IMAGE_REDUCE_QUALITY_STEPS = [85, 75, 65, 55, 45, 35] as const;
export const MAX_IMAGE_INPUT_PIXELS = 25_000_000;

export class ImageProcessorUnavailableError extends Error {
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

function createOpenClawRastermill() {
  return createRastermill({
    limits: {
      inputPixels: MAX_IMAGE_INPUT_PIXELS,
      outputPixels: MAX_IMAGE_INPUT_PIXELS,
    },
    env: {
      backendVar: "OPENCLAW_IMAGE_BACKEND",
    },
    temp: {
      rootDir: resolvePreferredOpenClawTmpDir(),
      prefix: () => `openclaw-img-${randomUUID()}-`,
    },
    commandResolver: (command) =>
      resolveSystemBin(command, { trust: command === "powershell" ? "strict" : "standard" }),
  });
}

export function isImageProcessorUnavailableError(err: unknown): boolean {
  if (err instanceof ImageProcessorUnavailableError || isRastermillUnavailableError(err)) {
    return true;
  }

  const messages: string[] = [];
  let current: unknown = err;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  const detail = messages.join("\n").toLowerCase();
  return (
    detail.includes("image processor unavailable") ||
    detail.includes("required image processor api") ||
    detail.includes("rastermill_image_processor_unavailable")
  );
}

export function buildImageResizeSideGrid(maxSide: number, sideStart: number): number[] {
  return [sideStart, 1800, 1600, 1400, 1200, 1000, 800]
    .map((value) => Math.min(maxSide, value))
    .filter((value, idx, arr) => value > 0 && arr.indexOf(value) === idx)
    .toSorted((a, b) => b - a);
}

function wrapRastermillUnavailable(operation: string, error: unknown): never {
  if (error instanceof RastermillUnavailableError) {
    throw new ImageProcessorUnavailableError(operation, error.message, error.causes);
  }
  throw error;
}

function assertImageInputWithinPixelBudget(buffer: Buffer): void {
  const metadata = readRastermillImageMetadataFromHeader(buffer);
  if (!metadata) {
    throw new Error("Unable to determine image dimensions; refusing to process");
  }
  if (metadata.width > Math.floor(MAX_IMAGE_INPUT_PIXELS / metadata.height)) {
    const pixels = Number.isSafeInteger(metadata.width * metadata.height)
      ? ` (${metadata.width * metadata.height} pixels)`
      : "";
    throw new Error(
      `Image dimensions exceed the ${MAX_IMAGE_INPUT_PIXELS.toLocaleString("en-US")} pixel input limit: ${metadata.width}x${metadata.height}${pixels}`,
    );
  }
}

export function readImageMetadataFromHeader(buffer: Buffer): ImageMetadata | null {
  return readRastermillImageMetadataFromHeader(buffer);
}

export async function getImageMetadata(buffer: Buffer): Promise<ImageMetadata | null> {
  const info = await createOpenClawRastermill().probe(buffer);
  return info ? { width: info.width, height: info.height } : null;
}

export async function normalizeExifOrientation(buffer: Buffer): Promise<Buffer> {
  try {
    assertImageInputWithinPixelBudget(buffer);
    const rastermill = createOpenClawRastermill();
    const info = await rastermill.probe(buffer);
    if (!info?.orientation || info.orientation === 1) {
      return buffer;
    }
    return (await rastermill.encode(buffer, { format: "jpeg", autoOrient: true })).data;
  } catch (error) {
    if (isImageProcessorUnavailableError(error)) {
      return buffer;
    }
    return wrapRastermillUnavailable("normalizeExifOrientation", error);
  }
}

export async function resizeToJpeg(params: ResizeToJpegParams): Promise<Buffer> {
  try {
    return (
      await createOpenClawRastermill().encode(params.buffer, {
        format: "jpeg",
        resize: {
          maxSide: params.maxSide,
          enlarge: params.withoutEnlargement === false,
        },
        quality: params.quality,
      })
    ).data;
  } catch (error) {
    return wrapRastermillUnavailable("resizeToJpeg", error);
  }
}

export async function convertHeicToJpeg(buffer: Buffer): Promise<Buffer> {
  try {
    return (await createOpenClawRastermill().encode(buffer, { format: "jpeg" })).data;
  } catch (error) {
    return wrapRastermillUnavailable("convertHeicToJpeg", error);
  }
}

export async function hasAlphaChannel(buffer: Buffer): Promise<boolean> {
  try {
    assertImageInputWithinPixelBudget(buffer);
    const rastermill = createOpenClawRastermill();
    const info = await rastermill.probe(buffer);
    if (!info) {
      return false;
    }
    if (info.hasAlpha !== null) {
      return info.hasAlpha;
    }
    try {
      const png = await rastermill.encode(buffer, {
        format: "png",
        autoOrient: false,
      });
      return readRastermillImageProbeFromHeader(png.data)?.hasAlpha ?? false;
    } catch {
      return false;
    }
  } catch (error) {
    if (isImageProcessorUnavailableError(error)) {
      return false;
    }
    throw error;
  }
}

export async function resizeToPng(params: ResizeToPngParams): Promise<Buffer> {
  try {
    return (
      await createOpenClawRastermill().encode(params.buffer, {
        format: "png",
        resize: {
          maxSide: params.maxSide,
          enlarge: params.withoutEnlargement === false,
        },
        png:
          params.compressionLevel === undefined
            ? {}
            : { compressionLevel: params.compressionLevel },
      })
    ).data;
  } catch (error) {
    return wrapRastermillUnavailable("resizeToPng", error);
  }
}

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
  try {
    const out = await createOpenClawRastermill().encodeWithinBytes(buffer, {
      format: "png",
      maxBytes,
      search: options?.sides === undefined ? {} : { maxSide: options.sides },
    });
    return {
      buffer: out.data,
      optimizedSize: out.bytes,
      resizeSide: out.chosen.maxSide ?? out.width,
      compressionLevel: out.chosen.compressionLevel ?? 6,
    };
  } catch (error) {
    return wrapRastermillUnavailable("optimizeImageToPng", error);
  }
}
