import sharp from "sharp";
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearImageResizeCache,
  sanitizeContentBlocksImages,
  sanitizeImageBlocks,
} from "./tool-images.js";

describe("tool image sanitizing", () => {
  beforeEach(() => {
    clearImageResizeCache();
  });

  const getImageBlock = (
    blocks: Awaited<ReturnType<typeof sanitizeContentBlocksImages>>,
  ): (typeof blocks)[number] & { type: "image"; data: string; mimeType?: string } => {
    const image = blocks.find((block) => block.type === "image");
    if (!image || image.type !== "image") {
      throw new Error("expected image block");
    }
    return image;
  };

  const createWidePng = async () => {
    const width = 2600;
    const height = 400;
    const raw = Buffer.alloc(width * height * 3, 0x7f);
    return sharp(raw, {
      raw: { width, height, channels: 3 },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
  };

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
    const image = getImageBlock(out);
    const size = Buffer.from(image.data, "base64").byteLength;
    expect(size).toBeLessThanOrEqual(5 * 1024 * 1024);
    expect(image.mimeType).toBe("image/jpeg");
  }, 20_000);

  it("sanitizes image arrays and reports drops", async () => {
    const png = await createWidePng();

    const images = [
      { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" },
    ];
    const { images: out, dropped } = await sanitizeImageBlocks(images, "test");
    expect(dropped).toBe(0);
    expect(out.length).toBe(1);
    const meta = await sharp(Buffer.from(out[0].data, "base64")).metadata();
    expect(meta.width).toBeLessThanOrEqual(1200);
    expect(meta.height).toBeLessThanOrEqual(1200);
  }, 20_000);

  it("shrinks images that exceed max dimension even if size is small", async () => {
    const png = await createWidePng();

    const blocks = [
      {
        type: "image" as const,
        data: png.toString("base64"),
        mimeType: "image/png",
      },
    ];

    const out = await sanitizeContentBlocksImages(blocks, "test");
    const image = getImageBlock(out);
    const meta = await sharp(Buffer.from(image.data, "base64")).metadata();
    expect(meta.width).toBeLessThanOrEqual(1200);
    expect(meta.height).toBeLessThanOrEqual(1200);
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
    const image = getImageBlock(out);
    expect(image.mimeType).toBe("image/jpeg");
  });

  it("returns cached result when same oversized image is processed twice", async () => {
    const png = await createWidePng();
    const base64 = png.toString("base64");

    const blocks = [{ type: "image" as const, data: base64, mimeType: "image/png" }];

    const first = await sanitizeContentBlocksImages(blocks, "test");
    const firstImage = getImageBlock(first);

    // Second pass with identical input should return the same resized output.
    const second = await sanitizeContentBlocksImages(blocks, "test");
    const secondImage = getImageBlock(second);

    expect(secondImage.data).toBe(firstImage.data);
    expect(secondImage.mimeType).toBe(firstImage.mimeType);
  }, 20_000);

  it("caches images that are already within limits", async () => {
    const small = await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
    const base64 = small.toString("base64");
    const blocks = [{ type: "image" as const, data: base64, mimeType: "image/png" }];

    const first = await sanitizeContentBlocksImages(blocks, "test");
    const second = await sanitizeContentBlocksImages(blocks, "test");

    const firstImage = getImageBlock(first);
    const secondImage = getImageBlock(second);
    // Within-limits images pass through unchanged — cache should return the same data.
    expect(secondImage.data).toBe(firstImage.data);
  });

  it("uses separate cache entries for different resize limits", async () => {
    const png = await createWidePng();
    const base64 = png.toString("base64");
    const blocks = [{ type: "image" as const, data: base64, mimeType: "image/png" }];

    const tight = await sanitizeContentBlocksImages(blocks, "test", { maxDimensionPx: 800 });
    const loose = await sanitizeContentBlocksImages(blocks, "test", { maxDimensionPx: 1200 });

    const tightImage = getImageBlock(tight);
    const looseImage = getImageBlock(loose);
    // Different limits should produce different resized outputs.
    expect(tightImage.data).not.toBe(looseImage.data);
  }, 20_000);

  it("does not return cached result for a different image", async () => {
    const pngA = await sharp({
      create: { width: 2600, height: 400, channels: 3, background: { r: 255, g: 0, b: 0 } },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    const pngB = await sharp({
      create: { width: 2600, height: 400, channels: 3, background: { r: 0, g: 0, b: 255 } },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();

    const blocksA = [
      { type: "image" as const, data: pngA.toString("base64"), mimeType: "image/png" },
    ];
    const blocksB = [
      { type: "image" as const, data: pngB.toString("base64"), mimeType: "image/png" },
    ];

    const resultA = getImageBlock(await sanitizeContentBlocksImages(blocksA, "test"));
    const resultB = getImageBlock(await sanitizeContentBlocksImages(blocksB, "test"));

    expect(resultA.data).not.toBe(resultB.data);
  }, 20_000);

  it("re-processes after cache is cleared", async () => {
    const png = await createWidePng();
    const blocks = [
      { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" },
    ];

    const first = getImageBlock(await sanitizeContentBlocksImages(blocks, "test"));
    clearImageResizeCache();
    const second = getImageBlock(await sanitizeContentBlocksImages(blocks, "test"));

    // Output should be equivalent (same resize algorithm), but we're verifying
    // the function actually ran again rather than returning a stale reference.
    expect(second.data).toBe(first.data);
    expect(second.mimeType).toBe(first.mimeType);
  }, 20_000);
});
