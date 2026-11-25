const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function detectSupportedImageMimeType(buffer: Uint8Array): string | null {
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
    return buffer[3] === 0xf7 ? null : "image/jpeg";
  }
  if (startsWith(buffer, PNG_SIGNATURE)) {
    return isPng(buffer) && !isAnimatedPng(buffer) ? "image/png" : null;
  }
  if (startsWithAscii(buffer, 0, "GIF")) {
    return "image/gif";
  }
  if (startsWithAscii(buffer, 0, "RIFF") && startsWithAscii(buffer, 8, "WEBP")) {
    return "image/webp";
  }
  if (startsWithAscii(buffer, 0, "BM") && isBmp(buffer)) {
    return "image/bmp";
  }
  return null;
}

function isPng(buffer: Uint8Array): boolean {
  return (
    buffer.length >= 16 &&
    readUint32(buffer, PNG_SIGNATURE.length, "big") === 13 &&
    startsWithAscii(buffer, 12, "IHDR")
  );
}

function isAnimatedPng(buffer: Uint8Array): boolean {
  let offset = PNG_SIGNATURE.length;
  while (offset + 8 <= buffer.length) {
    const chunkLength = readUint32(buffer, offset, "big");
    const chunkTypeOffset = offset + 4;
    if (startsWithAscii(buffer, chunkTypeOffset, "acTL")) {
      return true;
    }
    if (startsWithAscii(buffer, chunkTypeOffset, "IDAT")) {
      return false;
    }

    // PNG chunk length is untrusted input; bail if advancing would wrap or exceed the sniffed bytes.
    const nextOffset = offset + 8 + chunkLength + 4;
    if (nextOffset <= offset || nextOffset > buffer.length) {
      return false;
    }
    offset = nextOffset;
  }
  return false;
}

function isBmp(buffer: Uint8Array): boolean {
  if (buffer.length < 26) {
    return false;
  }
  const declaredFileSize = readUint32(buffer, 2, "little");
  const pixelDataOffset = readUint32(buffer, 10, "little");
  const dibHeaderSize = readUint32(buffer, 14, "little");
  if (declaredFileSize !== 0 && declaredFileSize < 26) {
    return false;
  }
  if (pixelDataOffset < 14 + dibHeaderSize) {
    return false;
  }
  if (declaredFileSize !== 0 && pixelDataOffset >= declaredFileSize) {
    return false;
  }

  let colorPlanes: number;
  let bitsPerPixel: number;
  if (dibHeaderSize === 12) {
    colorPlanes = readUint16LE(buffer, 22);
    bitsPerPixel = readUint16LE(buffer, 24);
  } else if (dibHeaderSize >= 40 && dibHeaderSize <= 124) {
    if (buffer.length < 30) {
      return false;
    }
    colorPlanes = readUint16LE(buffer, 26);
    bitsPerPixel = readUint16LE(buffer, 28);
  } else {
    return false;
  }
  return colorPlanes === 1 && [1, 4, 8, 16, 24, 32].includes(bitsPerPixel);
}

function readUint16LE(buffer: Uint8Array, offset: number): number {
  return (buffer[offset] ?? 0) + ((buffer[offset + 1] ?? 0) << 8);
}

function readUint32(buffer: Uint8Array, offset: number, byteOrder: "big" | "little"): number {
  let value = 0;
  for (let index = 0; index < 4; index++) {
    const shift = (byteOrder === "little" ? index : 3 - index) * 8;
    value += (buffer[offset + index] ?? 0) * 2 ** shift;
  }
  return value;
}

function startsWith(buffer: Uint8Array, bytes: number[]): boolean {
  if (buffer.length < bytes.length) {
    return false;
  }
  return bytes.every((byte, index) => buffer[index] === byte);
}

function startsWithAscii(buffer: Uint8Array, offset: number, text: string): boolean {
  if (buffer.length < offset + text.length) {
    return false;
  }
  for (let index = 0; index < text.length; index++) {
    if (buffer[offset + index] !== text.charCodeAt(index)) {
      return false;
    }
  }
  return true;
}
