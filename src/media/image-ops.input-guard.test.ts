import { describe, expect, it } from "vitest";
import { getImageMetadata, MAX_IMAGE_INPUT_PIXELS, resizeToJpeg } from "./image-ops.js";
import { createPngBufferWithDimensions } from "./test-helpers.js";

describe("image input pixel guard", () => {
  const oversizedPng = createPngBufferWithDimensions({ width: 8_000, height: 4_000 });
  const overflowedPng = createPngBufferWithDimensions({
    width: 4_294_967_295,
    height: 4_294_967_295,
  });

  it("returns null metadata for images above the pixel limit", async () => {
    await expect(getImageMetadata(oversizedPng)).resolves.toBeNull();
    expect(8_000 * 4_000).toBeGreaterThan(MAX_IMAGE_INPUT_PIXELS);
  });

  it("rejects oversized images before resize work starts", async () => {
    await expect(
      resizeToJpeg({
        buffer: oversizedPng,
        maxSide: 2_048,
        quality: 80,
      }),
    ).rejects.toThrow(/pixel input limit/i);
  });

  it("rejects overflowed pixel counts before resize work starts", async () => {
    await expect(
      resizeToJpeg({
        buffer: overflowedPng,
        maxSide: 2_048,
        quality: 80,
      }),
    ).rejects.toThrow(/pixel input limit/i);
  });

  it("fails closed when sips cannot determine image dimensions", async () => {
    const previousBackend = process.env.OPENCLAW_IMAGE_BACKEND;
    process.env.OPENCLAW_IMAGE_BACKEND = "sips";
    try {
      await expect(
        resizeToJpeg({
          buffer: Buffer.from("not-an-image"),
          maxSide: 2_048,
          quality: 80,
        }),
      ).rejects.toThrow(/unable to determine image dimensions/i);
    } finally {
      if (previousBackend === undefined) {
        delete process.env.OPENCLAW_IMAGE_BACKEND;
      } else {
        process.env.OPENCLAW_IMAGE_BACKEND = previousBackend;
      }
    }
  });
});
