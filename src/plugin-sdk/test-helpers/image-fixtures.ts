import { crc32, deflateSync } from "node:zlib";
import { encodePngRgb, encodePngRgba } from "../../media/png-encode.js";

type Rgba = { r: number; g: number; b: number; a?: number };

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Minimal valid JPEG used when tests only need container detection.
const TINY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/ASP/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/ASP/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Aqf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EFBQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EFBQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EFBABAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z",
  "base64",
);
function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

/** Create a solid-color PNG buffer, preserving alpha only when needed. */
export function createSolidPngBuffer(width: number, height: number, color: Rgba): Buffer {
  const opaque = color.a === undefined || color.a === 255;
  const pixel = Buffer.from(
    opaque ? [color.r, color.g, color.b] : [color.r, color.g, color.b, color.a ?? 255],
  );
  const pixels = Buffer.alloc(width * height * pixel.length, pixel);
  return (opaque ? encodePngRgb : encodePngRgba)(pixels, width, height);
}

export function createNoisyPngBuffer(width: number, height: number): Buffer {
  return encodePngRgb(createNoisyPixels(width, height, 3), width, height);
}

/** Create a grayscale+alpha PNG for image paths that must handle non-RGB color types. */
export function createGrayscaleAlphaPngBuffer(width: number, height: number): Buffer {
  const stride = width * 2;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    const rawOffset = row * (stride + 1);
    for (let column = 0; column < width; column += 1) {
      const pixel = rawOffset + 1 + column * 2;
      const seed = row * width + column;
      raw[pixel] = seed % 256;
      raw[pixel + 1] = seed % 5 === 0 ? 96 : 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 4;

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export function createTinyJpegBuffer(): Buffer {
  return Buffer.from(TINY_JPEG);
}

export function createNoisyRgbaBuffer(width: number, height: number): Buffer {
  return createNoisyPixels(width, height, 4);
}

function createNoisyPixels(width: number, height: number, channels: 3 | 4): Buffer {
  const pixels = Buffer.alloc(width * height * channels);
  for (let offset = 0; offset < pixels.length; offset += channels) {
    const seed = offset / channels;
    pixels[offset] = seed % 251;
    pixels[offset + 1] = (seed * 17) % 253;
    pixels[offset + 2] = (seed * 29) % 255;
    if (channels === 4) {
      pixels[offset + 3] = 255;
    }
  }
  return pixels;
}
