import {
  createRastermill,
  isRastermillUnavailableError,
  RastermillUnavailableError,
  readImageMetadataFromHeader as readRastermillImageMetadataFromHeader,
  type ImageBackendPreference,
  type ImageMetadata,
} from "@openclaw/rastermill";
import { resolveSystemBin } from "../infra/resolve-system-bin.js";

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

function normalizeOpenClawImageBackend(): ImageBackendPreference | undefined {
  const raw = process.env.OPENCLAW_IMAGE_BACKEND?.trim().toLowerCase();
  switch (raw) {
    case "photon":
    case "sips":
    case "windows-native":
    case "imagemagick":
    case "graphicsmagick":
    case "ffmpeg":
      return raw;
    case "windows":
    case "powershell":
    case "system.drawing":
    case "systemdrawing":
      return "windows-native";
    case "magick":
    case "convert":
      return "imagemagick";
    case "gm":
      return "graphicsmagick";
    default:
      return undefined;
  }
}

function createOpenClawRastermill() {
  return createRastermill({
    backend: normalizeOpenClawImageBackend(),
    maxInputPixels: MAX_IMAGE_INPUT_PIXELS,
    maxOutputPixels: MAX_IMAGE_INPUT_PIXELS,
    envBackendVariable: "OPENCLAW_IMAGE_BACKEND",
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

export function readImageMetadataFromHeader(buffer: Buffer): ImageMetadata | null {
  return readRastermillImageMetadataFromHeader(buffer);
}

export async function getImageMetadata(buffer: Buffer): Promise<ImageMetadata | null> {
  return await createOpenClawRastermill().metadata(buffer);
}

export async function normalizeExifOrientation(buffer: Buffer): Promise<Buffer> {
  try {
    return await createOpenClawRastermill().normalize(buffer);
  } catch (error) {
    if (isImageProcessorUnavailableError(error)) {
      return buffer;
    }
    return wrapRastermillUnavailable("normalizeExifOrientation", error);
  }
}

export async function resizeToJpeg(params: ResizeToJpegParams): Promise<Buffer> {
  try {
    return await createOpenClawRastermill().toJpeg(params.buffer, {
      maxSide: params.maxSide,
      quality: params.quality,
      withoutEnlargement: params.withoutEnlargement,
    });
  } catch (error) {
    return wrapRastermillUnavailable("resizeToJpeg", error);
  }
}

export async function convertHeicToJpeg(buffer: Buffer): Promise<Buffer> {
  try {
    return await createOpenClawRastermill().convertHeicToJpeg(buffer);
  } catch (error) {
    return wrapRastermillUnavailable("convertHeicToJpeg", error);
  }
}

export async function hasAlphaChannel(buffer: Buffer): Promise<boolean> {
  try {
    return await createOpenClawRastermill().hasAlpha(buffer);
  } catch (error) {
    if (isImageProcessorUnavailableError(error)) {
      return false;
    }
    throw error;
  }
}

export async function resizeToPng(params: ResizeToPngParams): Promise<Buffer> {
  try {
    return await createOpenClawRastermill().toPng(params.buffer, {
      maxSide: params.maxSide,
      compressionLevel: params.compressionLevel,
      withoutEnlargement: params.withoutEnlargement,
    });
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
    return await createOpenClawRastermill().optimizePng(buffer, {
      maxBytes,
      sides: options?.sides,
    });
  } catch (error) {
    return wrapRastermillUnavailable("optimizeImageToPng", error);
  }
}
