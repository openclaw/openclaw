export function createPngBufferWithDimensions(params: { width: number; height: number }): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrLength = Buffer.from([0x00, 0x00, 0x00, 0x0d]);
  const ihdrType = Buffer.from("IHDR", "ascii");
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(params.width, 0);
  ihdrData.writeUInt32BE(params.height, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 6;
  const ihdrCrc = Buffer.alloc(4);
  const iend = Buffer.from([
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
  return Buffer.concat([signature, ihdrLength, ihdrType, ihdrData, ihdrCrc, iend]);
}

export function createJpegBufferWithDimensions(params: { width: number; height: number }): Buffer {
  if (params.width > 0xffff || params.height > 0xffff) {
    throw new Error("Synthetic JPEG helper only supports 16-bit dimensions");
  }

  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01,
    0x00, 0x00,
  ]);
  const sof0 = Buffer.from([
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    params.height >> 8,
    params.height & 0xff,
    params.width >> 8,
    params.width & 0xff,
    0x03,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x00,
    0x03,
    0x11,
    0x00,
  ]);
  const sos = Buffer.from([
    0xff, 0xda, 0x00, 0x0c, 0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00,
  ]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof0, sos, Buffer.from([0xff, 0xd9])]);
}
