import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runExec } from "../process/exec.js";

type Sharp = typeof import("sharp");

export type ImageMetadata = {
  width: number;
  height: number;
};

function isBun(): boolean {
  return typeof (process.versions as { bun?: unknown }).bun === "string";
}


async function loadSharp(): Promise<(buffer: Buffer) => ReturnType<Sharp>> {
  const mod = (await import("sharp")) as unknown as { default?: Sharp };
  const sharp = mod.default ?? (mod as unknown as Sharp);
  return (buffer) => sharp(buffer, { failOnError: false });
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


export async function getImageMetadata(buffer: Buffer): Promise<ImageMetadata | null> {

  try {
    const sharp = await loadSharp();
    const meta = await sharp(buffer).metadata();
    const width = Number(meta.width ?? 0);
    const height = Number(meta.height ?? 0);
    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      return null;
    }
    if (width <= 0 || height <= 0) {
      return null;
    }
    return { width, height };
  } catch {
    return null;
  }
}

/**
 * Applies rotation/flip to image buffer using sips based on EXIF orientation.
 */

/**
 * Normalizes EXIF orientation in an image buffer.
 * Returns the buffer with correct pixel orientation (rotated if needed).
 * Falls back to original buffer if normalization fails.
 */
export async function normalizeExifOrientation(buffer: Buffer): Promise<Buffer> {

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
