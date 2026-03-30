import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runExec } from "../process/exec.js";

type Sharp = typeof import("sharp");

export type ImageMetadata = {
  width: number;
  height: number;
};

export const IMAGE_REDUCE_QUALITY_STEPS = [85, 75, 65, 55, 45, 35] as const;
export const MAX_IMAGE_INPUT_PIXELS = 25_000_000;

class ImagePixelLimitError extends Error {
  constructor(metadata?: ImageMetadata) {
    const detail = metadata ? ` (${metadata.width}x${metadata.height})` : "";
    super(`Image dimensions exceed the maximum allowed pixel count${detail}`);
  }
}

export function buildImageResizeSideGrid(maxSide: number, sideStart: number): number[] {
  return [sideStart, 1800, 1600, 1400, 1200, 1000, 800]
    .map((value) => Math.min(maxSide, value))
    .filter((value, idx, arr) => value > 0 && arr.indexOf(value) === idx)
    .toSorted((a, b) => b - a);
}

function isBun(): boolean {
  return typeof (process.versions as { bun?: unknown }).bun === "string";
}

function prefersSips(): boolean {
  return (
    process.env.OPENCLAW_IMAGE_BACKEND === "sips" ||
    (process.env.OPENCLAW_IMAGE_BACKEND !== "sharp" && isBun() && process.platform === "darwin")
  );
}

async function loadSharp(): Promise<(buffer: Buffer) => ReturnType<Sharp>> {
  const mod = (await import("sharp")) as unknown as { default?: Sharp };
  const sharp = mod.default ?? (mod as unknown as Sharp);
  return (buffer) =>
    sharp(buffer, { failOnError: false, limitInputPixels: MAX_IMAGE_INPUT_PIXELS });
}

function normalizeImageMetadata(width: number, height: number): ImageMetadata | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return null;
  }
  if (width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
}

function exceedsImagePixelLimit(metadata: ImageMetadata): boolean {
  return metadata.width > Math.floor(MAX_IMAGE_INPUT_PIXELS / metadata.height);
}

function assertImagePixelLimit(metadata: ImageMetadata): void {
  if (exceedsImagePixelLimit(metadata)) {
    throw new ImagePixelLimitError(metadata);
  }
}

function readPngMetadata(buffer: Buffer): ImageMetadata | null {
  const pngSignature = "\x89PNG\r\n\x1a\n";
  if (buffer.length < 24 || buffer.toString("latin1", 0, 8) !== pngSignature) {
    return null;
  }
  if (buffer.toString("ascii", 12, 16) !== "IHDR") {
    return null;
  }
  return normalizeImageMetadata(buffer.readUInt32BE(16), buffer.readUInt32BE(20));
}

function readGifMetadata(buffer: Buffer): ImageMetadata | null {
  const signature = buffer.toString("ascii", 0, 6);
  if (buffer.length < 10 || (signature !== "GIF87a" && signature !== "GIF89a")) {
    return null;
  }
  return normalizeImageMetadata(buffer.readUInt16LE(6), buffer.readUInt16LE(8));
}

function isJpegStartOfFrameMarker(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

function readJpegMetadata(buffer: Buffer): ImageMetadata | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }

  let offset = 2;
  while (offset + 3 < buffer.length) {
    while (offset < buffer.length && buffer[offset] === 0xff) {
      offset += 1;
    }
    if (offset >= buffer.length) {
      break;
    }

    const marker = buffer[offset];
    offset += 1;

    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) {
      continue;
    }
    if (marker >= 0xd0 && marker <= 0xd7) {
      continue;
    }
    if (offset + 1 >= buffer.length) {
      break;
    }

    const segmentLength = buffer.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > buffer.length) {
      break;
    }
    if (isJpegStartOfFrameMarker(marker)) {
      if (segmentLength < 7 || offset + 6 >= buffer.length) {
        break;
      }
      return normalizeImageMetadata(
        buffer.readUInt16BE(offset + 5),
        buffer.readUInt16BE(offset + 3),
      );
    }
    offset += segmentLength;
  }

  return null;
}

export function probeImageMetadataFromHeader(buffer: Buffer): ImageMetadata | null {
  return readPngMetadata(buffer) ?? readGifMetadata(buffer) ?? readJpegMetadata(buffer);
}

function isSharpPixelLimitError(error: unknown): boolean {
  return error instanceof Error && /pixel limit/i.test(error.message);
}

async function getSharpImageMetadata(buffer: Buffer): Promise<ImageMetadata | null> {
  const sharp = await loadSharp();
  try {
    const meta = await sharp(buffer).metadata();
    const metadata = normalizeImageMetadata(Number(meta.width ?? 0), Number(meta.height ?? 0));
    if (!metadata) {
      return null;
    }
    assertImagePixelLimit(metadata);
    return metadata;
  } catch (error) {
    if (isSharpPixelLimitError(error)) {
      throw new ImagePixelLimitError();
    }
    throw error;
  }
}

async function assertImageBufferWithinPixelLimit(buffer: Buffer): Promise<void> {
  const headerMetadata = probeImageMetadataFromHeader(buffer);
  if (headerMetadata) {
    assertImagePixelLimit(headerMetadata);
    return;
  }

  try {
    await getSharpImageMetadata(buffer);
  } catch (error) {
    if (error instanceof ImagePixelLimitError) {
      throw error;
    }
  }
}

/**
 * Reads EXIF orientation from JPEG buffer.
 * Returns orientation value 1-8, or null if not found/not JPEG.
 *
 * EXIF orientation values:
 * 1 = Normal, 2 = Flip H, 3 = Rotate 180, 4 = Flip V,
 * 5 = Rotate 270 CW + Flip H, 6 = Rotate 90 CW, 7 = Rotate 90 CW + Flip H, 8 = Rotate 270 CW
 */
function readJpegExifOrientation(buffer: Buffer): number | null {
  // Check JPEG magic bytes
  if (buffer.length < 2 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }

  let offset = 2;
  while (offset < buffer.length - 4) {
    // Look for marker
    if (buffer[offset] !== 0xff) {
      offset++;
      continue;
    }

    const marker = buffer[offset + 1];
    // Skip padding FF bytes
    if (marker === 0xff) {
      offset++;
      continue;
    }

    // APP1 marker (EXIF)
    if (marker === 0xe1) {
      const exifStart = offset + 4;

      // Check for "Exif\0\0" header
      if (
        buffer.length > exifStart + 6 &&
        buffer.toString("ascii", exifStart, exifStart + 4) === "Exif" &&
        buffer[exifStart + 4] === 0 &&
        buffer[exifStart + 5] === 0
      ) {
        const tiffStart = exifStart + 6;
        if (buffer.length < tiffStart + 8) {
          return null;
        }

        // Check byte order (II = little-endian, MM = big-endian)
        const byteOrder = buffer.toString("ascii", tiffStart, tiffStart + 2);
        const isLittleEndian = byteOrder === "II";

        const readU16 = (pos: number) =>
          isLittleEndian ? buffer.readUInt16LE(pos) : buffer.readUInt16BE(pos);
        const readU32 = (pos: number) =>
          isLittleEndian ? buffer.readUInt32LE(pos) : buffer.readUInt32BE(pos);

        // Read IFD0 offset
        const ifd0Offset = readU32(tiffStart + 4);
        const ifd0Start = tiffStart + ifd0Offset;
        if (buffer.length < ifd0Start + 2) {
          return null;
        }

        const numEntries = readU16(ifd0Start);
        for (let i = 0; i < numEntries; i++) {
          const entryOffset = ifd0Start + 2 + i * 12;
          if (buffer.length < entryOffset + 12) {
            break;
          }

          const tag = readU16(entryOffset);
          // Orientation tag = 0x0112
          if (tag === 0x0112) {
            const value = readU16(entryOffset + 8);
            return value >= 1 && value <= 8 ? value : null;
          }
        }
      }
      return null;
    }

    // Skip other segments
    if (marker >= 0xe0 && marker <= 0xef) {
      const segmentLength = buffer.readUInt16BE(offset + 2);
      offset += 2 + segmentLength;
      continue;
    }

    // SOF, SOS, or other marker - stop searching
    if (marker === 0xc0 || marker === 0xda) {
      break;
    }

    offset++;
  }

  return null;
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-img-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function sipsMetadataFromBuffer(buffer: Buffer): Promise<ImageMetadata | null> {
  return await withTempDir(async (dir) => {
    const input = path.join(dir, "in.img");
    await fs.writeFile(input, buffer);
    const { stdout } = await runExec(
      "/usr/bin/sips",
      ["-g", "pixelWidth", "-g", "pixelHeight", input],
      {
        timeoutMs: 10_000,
        maxBuffer: 512 * 1024,
      },
    );
    const w = stdout.match(/pixelWidth:\s*([0-9]+)/);
    const h = stdout.match(/pixelHeight:\s*([0-9]+)/);
    if (!w?.[1] || !h?.[1]) {
      return null;
    }
    const width = Number.parseInt(w[1], 10);
    const height = Number.parseInt(h[1], 10);
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      return null;
    }
    if (width <= 0 || height <= 0) {
      return null;
    }
    return { width, height };
  });
}

async function sipsResizeToJpeg(params: {
  buffer: Buffer;
  maxSide: number;
  quality: number;
}): Promise<Buffer> {
  return await withTempDir(async (dir) => {
    const input = path.join(dir, "in.img");
    const output = path.join(dir, "out.jpg");
    await fs.writeFile(input, params.buffer);
    await runExec(
      "/usr/bin/sips",
      [
        "-Z",
        String(Math.max(1, Math.round(params.maxSide))),
        "-s",
        "format",
        "jpeg",
        "-s",
        "formatOptions",
        String(Math.max(1, Math.min(100, Math.round(params.quality)))),
        input,
        "--out",
        output,
      ],
      { timeoutMs: 20_000, maxBuffer: 1024 * 1024 },
    );
    return await fs.readFile(output);
  });
}

async function sipsConvertToJpeg(buffer: Buffer): Promise<Buffer> {
  return await withTempDir(async (dir) => {
    const input = path.join(dir, "in.heic");
    const output = path.join(dir, "out.jpg");
    await fs.writeFile(input, buffer);
    await runExec("/usr/bin/sips", ["-s", "format", "jpeg", input, "--out", output], {
      timeoutMs: 20_000,
      maxBuffer: 1024 * 1024,
    });
    return await fs.readFile(output);
  });
}

export async function getImageMetadata(buffer: Buffer): Promise<ImageMetadata | null> {
  const headerMetadata = probeImageMetadataFromHeader(buffer);
  if (headerMetadata) {
    try {
      assertImagePixelLimit(headerMetadata);
      return headerMetadata;
    } catch {
      return null;
    }
  }

  if (prefersSips()) {
    try {
      // Keep sips as the metadata backend on preferred platforms, but only
      // after the shared pixel-limit guard confirms the buffer is safe.
      await assertImageBufferWithinPixelLimit(buffer);
      return await sipsMetadataFromBuffer(buffer);
    } catch {
      return null;
    }
  }

  try {
    return await getSharpImageMetadata(buffer);
  } catch {
    return null;
  }
}

/**
 * Applies rotation/flip to image buffer using sips based on EXIF orientation.
 */
async function sipsApplyOrientation(buffer: Buffer, orientation: number): Promise<Buffer> {
  // Map EXIF orientation to sips operations
  // sips -r rotates clockwise, -f flips (horizontal/vertical)
  const ops: string[] = [];
  switch (orientation) {
    case 2: // Flip horizontal
      ops.push("-f", "horizontal");
      break;
    case 3: // Rotate 180
      ops.push("-r", "180");
      break;
    case 4: // Flip vertical
      ops.push("-f", "vertical");
      break;
    case 5: // Rotate 270 CW + flip horizontal
      ops.push("-r", "270", "-f", "horizontal");
      break;
    case 6: // Rotate 90 CW
      ops.push("-r", "90");
      break;
    case 7: // Rotate 90 CW + flip horizontal
      ops.push("-r", "90", "-f", "horizontal");
      break;
    case 8: // Rotate 270 CW
      ops.push("-r", "270");
      break;
    default:
      // Orientation 1 or unknown - no change needed
      return buffer;
  }

  return await withTempDir(async (dir) => {
    const input = path.join(dir, "in.jpg");
    const output = path.join(dir, "out.jpg");
    await fs.writeFile(input, buffer);
    await runExec("/usr/bin/sips", [...ops, input, "--out", output], {
      timeoutMs: 20_000,
      maxBuffer: 1024 * 1024,
    });
    return await fs.readFile(output);
  });
}

/**
 * Normalizes EXIF orientation in an image buffer.
 * Returns the buffer with correct pixel orientation (rotated if needed).
 * Falls back to original buffer if normalization fails.
 */
export async function normalizeExifOrientation(buffer: Buffer): Promise<Buffer> {
  if (prefersSips()) {
    await assertImageBufferWithinPixelLimit(buffer);
    try {
      const orientation = readJpegExifOrientation(buffer);
      if (!orientation || orientation === 1) {
        return buffer; // No rotation needed
      }
      return await sipsApplyOrientation(buffer, orientation);
    } catch {
      return buffer;
    }
  }

  try {
    const sharp = await loadSharp();
    // .rotate() with no args auto-rotates based on EXIF orientation
    return await sharp(buffer).rotate().toBuffer();
  } catch {
    // Sharp not available or failed - return original buffer
    return buffer;
  }
}

export async function resizeToJpeg(params: {
  buffer: Buffer;
  maxSide: number;
  quality: number;
  withoutEnlargement?: boolean;
}): Promise<Buffer> {
  if (prefersSips()) {
    await assertImageBufferWithinPixelLimit(params.buffer);
    // Normalize EXIF orientation BEFORE resizing (sips resize doesn't auto-rotate)
    const normalized = await normalizeExifOrientationSips(params.buffer);

    // Avoid enlarging by checking dimensions first (sips has no withoutEnlargement flag).
    if (params.withoutEnlargement !== false) {
      const meta = await getImageMetadata(normalized);
      if (meta) {
        const maxDim = Math.max(meta.width, meta.height);
        if (maxDim > 0 && maxDim <= params.maxSide) {
          return await sipsResizeToJpeg({
            buffer: normalized,
            maxSide: maxDim,
            quality: params.quality,
          });
        }
      }
    }
    return await sipsResizeToJpeg({
      buffer: normalized,
      maxSide: params.maxSide,
      quality: params.quality,
    });
  }

  const sharp = await loadSharp();
  // Use .rotate() BEFORE .resize() to auto-rotate based on EXIF orientation
  return await sharp(params.buffer)
    .rotate() // Auto-rotate based on EXIF before resizing
    .resize({
      width: params.maxSide,
      height: params.maxSide,
      fit: "inside",
      withoutEnlargement: params.withoutEnlargement !== false,
    })
    .jpeg({ quality: params.quality, mozjpeg: true })
    .toBuffer();
}

export async function convertHeicToJpeg(buffer: Buffer): Promise<Buffer> {
  if (prefersSips()) {
    await assertImageBufferWithinPixelLimit(buffer);
    return await sipsConvertToJpeg(buffer);
  }
  const sharp = await loadSharp();
  return await sharp(buffer).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}

/**
 * Checks if an image has an alpha channel (transparency).
 * Returns true if the image has alpha, false otherwise.
 */
export async function hasAlphaChannel(buffer: Buffer): Promise<boolean> {
  try {
    const sharp = await loadSharp();
    const meta = await sharp(buffer).metadata();
    // Check if the image has an alpha channel
    // PNG color types with alpha: 4 (grayscale+alpha), 6 (RGBA)
    // Sharp reports this via 'channels' (4 = RGBA) or 'hasAlpha'
    return meta.hasAlpha || meta.channels === 4;
  } catch {
    return false;
  }
}

/**
 * Resizes an image to PNG format, preserving alpha channel (transparency).
 * Falls back to sharp only (no sips fallback for PNG with alpha).
 */
export async function resizeToPng(params: {
  buffer: Buffer;
  maxSide: number;
  compressionLevel?: number;
  withoutEnlargement?: boolean;
}): Promise<Buffer> {
  const sharp = await loadSharp();
  // Compression level 6 is a good balance (0=fastest, 9=smallest)
  const compressionLevel = params.compressionLevel ?? 6;

  return await sharp(params.buffer)
    .rotate() // Auto-rotate based on EXIF if present
    .resize({
      width: params.maxSide,
      height: params.maxSide,
      fit: "inside",
      withoutEnlargement: params.withoutEnlargement !== false,
    })
    .png({ compressionLevel })
    .toBuffer();
}

export async function optimizeImageToPng(
  buffer: Buffer,
  maxBytes: number,
): Promise<{
  buffer: Buffer;
  optimizedSize: number;
  resizeSide: number;
  compressionLevel: number;
}> {
  // Try a grid of sizes/compression levels until under the limit.
  // PNG uses compression levels 0-9 (higher = smaller but slower).
  const sides = [2048, 1536, 1280, 1024, 800];
  const compressionLevels = [6, 7, 8, 9];
  let smallest: {
    buffer: Buffer;
    size: number;
    resizeSide: number;
    compressionLevel: number;
  } | null = null;

  for (const side of sides) {
    for (const compressionLevel of compressionLevels) {
      try {
        const out = await resizeToPng({
          buffer,
          maxSide: side,
          compressionLevel,
          withoutEnlargement: true,
        });
        const size = out.length;
        if (!smallest || size < smallest.size) {
          smallest = { buffer: out, size, resizeSide: side, compressionLevel };
        }
        if (size <= maxBytes) {
          return {
            buffer: out,
            optimizedSize: size,
            resizeSide: side,
            compressionLevel,
          };
        }
      } catch {
        // Continue trying other size/compression combinations.
      }
    }
  }

  if (smallest) {
    return {
      buffer: smallest.buffer,
      optimizedSize: smallest.size,
      resizeSide: smallest.resizeSide,
      compressionLevel: smallest.compressionLevel,
    };
  }

  throw new Error("Failed to optimize PNG image");
}

/**
 * Internal sips-only EXIF normalization (no sharp fallback).
 * Used by resizeToJpeg to normalize before sips resize.
 */
async function normalizeExifOrientationSips(buffer: Buffer): Promise<Buffer> {
  try {
    const orientation = readJpegExifOrientation(buffer);
    if (!orientation || orientation === 1) {
      return buffer;
    }
    return await sipsApplyOrientation(buffer, orientation);
  } catch {
    return buffer;
  }
}
