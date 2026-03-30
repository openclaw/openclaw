import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const runExecMock = vi.fn();

vi.mock("../process/exec.js", () => ({
  runExec: (...args: unknown[]) => runExecMock(...args),
}));

let MAX_IMAGE_INPUT_PIXELS: typeof import("./image-ops.js").MAX_IMAGE_INPUT_PIXELS;
let getImageMetadata: typeof import("./image-ops.js").getImageMetadata;
let probeImageMetadataFromHeader: typeof import("./image-ops.js").probeImageMetadataFromHeader;
let resizeToJpeg: typeof import("./image-ops.js").resizeToJpeg;

beforeAll(async () => {
  ({ MAX_IMAGE_INPUT_PIXELS, getImageMetadata, probeImageMetadataFromHeader, resizeToJpeg } =
    await import("./image-ops.js"));
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  delete process.env.OPENCLAW_IMAGE_BACKEND;
});

function createPngHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write("IHDR", 12, "ascii");
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  buffer[24] = 8;
  buffer[25] = 6;
  return buffer;
}

function createGifHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(10);
  buffer.write("GIF89a", 0, "ascii");
  buffer.writeUInt16LE(width, 6);
  buffer.writeUInt16LE(height, 8);
  return buffer;
}

function createJpegHeader(width: number, height: number): Buffer {
  const buffer = Buffer.alloc(21);
  buffer.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08], 0);
  buffer.writeUInt16BE(height, 7);
  buffer.writeUInt16BE(width, 9);
  buffer.set([0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00], 11);
  return buffer;
}

describe("probeImageMetadataFromHeader", () => {
  it.each([
    {
      name: "png",
      buffer: createPngHeader(640, 480),
      expected: { width: 640, height: 480 },
    },
    {
      name: "gif",
      buffer: createGifHeader(320, 200),
      expected: { width: 320, height: 200 },
    },
    {
      name: "jpeg",
      buffer: createJpegHeader(800, 600),
      expected: { width: 800, height: 600 },
    },
  ] as const)("reads %s dimensions without decoding image data", ({ buffer, expected }) => {
    expect(probeImageMetadataFromHeader(buffer)).toEqual(expected);
  });
});

describe("image pixel limit guard", () => {
  it("returns null metadata for oversized image headers", async () => {
    const oversized = createPngHeader(5_001, 5_001);

    await expect(getImageMetadata(oversized)).resolves.toBeNull();
    expect(runExecMock).not.toHaveBeenCalled();
    expect(5_001 * 5_001).toBeGreaterThan(MAX_IMAGE_INPUT_PIXELS);
  });

  it("rejects oversized images before invoking sips", async () => {
    process.env.OPENCLAW_IMAGE_BACKEND = "sips";
    const oversized = createPngHeader(5_001, 5_001);

    await expect(
      resizeToJpeg({
        buffer: oversized,
        maxSide: 1024,
        quality: 85,
      }),
    ).rejects.toThrow(/maximum allowed pixel count/i);
    expect(runExecMock).not.toHaveBeenCalled();
  });
});
