import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";

const mocks = vi.hoisted(() => ({ createImageProcessorWithPixelLimits: vi.fn() }));

vi.mock("./image-processor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./image-processor.js")>()),
  createImageProcessorWithPixelLimits: mocks.createImageProcessorWithPixelLimits,
}));

import { loadWebMedia, optimizeImageBufferForWebMedia } from "./web-media.js";

const source = (() => {
  const buffer = createSolidPngBuffer(2, 2, { r: 22, g: 45, b: 78 });
  buffer.writeUInt32BE(5658, 16);
  buffer.writeUInt32BE(5655, 20);
  return buffer;
})();
const output = createSolidPngBuffer(32, 32, { r: 22, g: 45, b: 78 });

describe("web media configured input pixel limit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createImageProcessorWithPixelLimits.mockReturnValue({
      encode: vi.fn(async () => ({
        data: output,
        bytes: output.byteLength,
        base64Bytes: Math.ceil(output.byteLength / 3) * 4,
        width: 32,
        height: 32,
        format: "png",
        mimeType: "image/png",
        metadata: "stripped",
        resized: true,
        chosen: { format: "png", maxSide: 32, compressionLevel: 8 },
      })),
    });
  });

  it("raises source admission only while keeping the output cap unchanged", async () => {
    const result = await optimizeImageBufferForWebMedia({
      buffer: source,
      contentType: "image/png",
      fileName: "screenshot.png",
      maxBytes: 1024 * 1024,
      imageCompression: { models: [{ maxSidePx: 32 }] },
      maxInputPixels: 50_000_000,
    });

    expect(mocks.createImageProcessorWithPixelLimits).toHaveBeenCalledWith({
      inputPixels: 50_000_000,
      outputPixels: 25_000_000,
    });
    expect(result.buffer).toEqual(output);
    expect(result.contentType).toBe("image/png");
  });

  it("threads the configured input limit through local media loading", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-web-media-pixel-limit-"));
    const imagePath = path.join(root, "screenshot.png");
    await fs.writeFile(imagePath, source);
    try {
      const result = await loadWebMedia(imagePath, {
        localRoots: [root],
        maxBytes: 1024 * 1024,
        imageCompression: { models: [{ maxSidePx: 32 }] },
        maxInputPixels: 50_000_000,
      });
      expect(mocks.createImageProcessorWithPixelLimits).toHaveBeenCalledWith({
        inputPixels: 50_000_000,
        outputPixels: 25_000_000,
      });
      expect(result.buffer).toEqual(output);
      expect(result.contentType).toBe("image/png");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
