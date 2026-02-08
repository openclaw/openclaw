import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { sanitizeContentBlocksImages, sanitizeImageBlocks } from "./tool-images.js";

describe("tool image sanitizing", () => {
  it("shrinks oversized images to <=5MB", async () => {
    const width = 2800;
    const height = 2800;
    const raw = Buffer.alloc(width * height * 3, 0xff);
    const bigPng = await sharp(raw, {
      raw: { width, height, channels: 3 },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();
    expect(bigPng.byteLength).toBeGreaterThan(5 * 1024 * 1024);

    const blocks = [
      {
        type: "image" as const,
        data: bigPng.toString("base64"),
        mimeType: "image/png",
      },
    ];

    const out = await sanitizeContentBlocksImages(blocks, "test");
    const image = out.find((b) => b.type === "image");
    if (!image || image.type !== "image") {
      throw new Error("expected image block");
    }
    const size = Buffer.from(image.data, "base64").byteLength;
    expect(size).toBeLessThanOrEqual(5 * 1024 * 1024);
    expect(image.mimeType).toBe("image/jpeg");
  }, 20_000);

  it("sanitizes image arrays and reports drops", async () => {
    const width = 2600;
    const height = 400;
    const raw = Buffer.alloc(width * height * 3, 0x7f);
    const png = await sharp(raw, {
      raw: { width, height, channels: 3 },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();

    const images = [
      { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" },
    ];
    const { images: out, dropped } = await sanitizeImageBlocks(images, "test");
    expect(dropped).toBe(0);
    expect(out.length).toBe(1);
    const meta = await sharp(Buffer.from(out[0].data, "base64")).metadata();
    expect(meta.width).toBeLessThanOrEqual(2000);
    expect(meta.height).toBeLessThanOrEqual(2000);
  }, 20_000);

  it("shrinks images that exceed max dimension even if size is small", async () => {
    const width = 2600;
    const height = 400;
    const raw = Buffer.alloc(width * height * 3, 0x7f);
    const png = await sharp(raw, {
      raw: { width, height, channels: 3 },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();

    const blocks = [
      {
        type: "image" as const,
        data: png.toString("base64"),
        mimeType: "image/png",
      },
    ];

    const out = await sanitizeContentBlocksImages(blocks, "test");
    const image = out.find((b) => b.type === "image");
    if (!image || image.type !== "image") {
      throw new Error("expected image block");
    }
    const meta = await sharp(Buffer.from(image.data, "base64")).metadata();
    expect(meta.width).toBeLessThanOrEqual(2000);
    expect(meta.height).toBeLessThanOrEqual(2000);
    expect(image.mimeType).toBe("image/jpeg");
  }, 20_000);

  it("corrects mismatched jpeg mimeType", async () => {
    const jpeg = await sharp({
      create: {
        width: 10,
        height: 10,
        channels: 3,
        background: { r: 255, g: 0, b: 0 },
      },
    })
      .jpeg()
      .toBuffer();

    const blocks = [
      {
        type: "image" as const,
        data: jpeg.toString("base64"),
        mimeType: "image/png",
      },
    ];

    const out = await sanitizeContentBlocksImages(blocks, "test");
    const image = out.find((b) => b.type === "image");
    if (!image || image.type !== "image") {
      throw new Error("expected image block");
    }
    expect(image.mimeType).toBe("image/jpeg");
  });

  it("resizes images where decoded bytes < limit but base64 string > limit", async () => {
    // This test verifies the fix for issue #5344:
    // The API enforces the limit on base64 string length, not decoded bytes.
    // Base64 encoding inflates data by ~33%, so an image with decoded size 4MB
    // produces a base64 string of ~5.3MB, which exceeds the 5MB API limit.
    const width = 2200;
    const height = 2200;
    const raw = Buffer.alloc(width * height * 3, 0xaa);
    const png = await sharp(raw, {
      raw: { width, height, channels: 3 },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();

    const base64 = png.toString("base64");
    const decodedBytes = png.byteLength;
    const base64Length = base64.length;

    // Verify test precondition: decoded bytes could be under 5MB but base64 over 5MB
    // (due to compression this may vary, but the logic should handle both correctly)
    expect(base64Length).toBeGreaterThan(decodedBytes);
    expect(base64Length / decodedBytes).toBeCloseTo(4 / 3, 1); // ~1.33x inflation

    const blocks = [
      {
        type: "image" as const,
        data: base64,
        mimeType: "image/png",
      },
    ];

    // Use maxBytes as the limit for base64 string length
    const maxBytes = 5 * 1024 * 1024;
    const out = await sanitizeContentBlocksImages(blocks, "test", { maxBytes });
    const image = out.find((b) => b.type === "image");
    if (!image || image.type !== "image") {
      throw new Error("expected image block");
    }

    // The output base64 string should be within the limit
    expect(image.data.length).toBeLessThanOrEqual(maxBytes);
  }, 20_000);
});
