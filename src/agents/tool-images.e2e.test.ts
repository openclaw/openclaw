import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { sanitizeContentBlocksImages, sanitizeImageBlocks } from "./tool-images.js";

describe("tool image sanitizing", () => {
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

  it("rejects invalid base64 data gracefully", async () => {
    const blocks = [
      {
        type: "image" as const,
        data: "not-valid-base64!!!@#$%",
        mimeType: "image/png",
      },
    ];

    const out = await sanitizeContentBlocksImages(blocks, "test");
    expect(out.length).toBe(1);
    expect(out[0].type).toBe("text");
    if (out[0].type === "text") {
      expect(out[0].text).toContain("invalid base64");
    }
  });

  it("strips data URL prefix and processes the image", async () => {
    const jpeg = await sharp({
      create: {
        width: 10,
        height: 10,
        channels: 3,
        background: { r: 0, g: 255, b: 0 },
      },
    })
      .jpeg()
      .toBuffer();

    const rawBase64 = jpeg.toString("base64");
    const blocks = [
      {
        type: "image" as const,
        data: `data:image/jpeg;base64,${rawBase64}`,
        mimeType: "image/jpeg",
      },
    ];

    const out = await sanitizeContentBlocksImages(blocks, "test");
    const image = out.find((b) => b.type === "image");
    if (!image || image.type !== "image") {
      throw new Error("expected image block");
    }
    // The data URL prefix should be stripped — the output should be raw base64
    expect(image.data).not.toContain("data:");
    expect(image.mimeType).toBe("image/jpeg");
  });

  it("handles base64 with MIME-style line breaks", async () => {
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

    const rawBase64 = jpeg.toString("base64");
    // Insert newlines every 76 chars (MIME-style)
    const mimeBase64 = rawBase64.replace(/(.{76})/g, "$1\n");
    const blocks = [
      {
        type: "image" as const,
        data: mimeBase64,
        mimeType: "image/jpeg",
      },
    ];

    const out = await sanitizeContentBlocksImages(blocks, "test");
    const image = out.find((b) => b.type === "image");
    if (!image || image.type !== "image") {
      throw new Error("expected image block, not text replacement");
    }
    // Should still be a valid image after whitespace stripping
    expect(image.data).not.toContain("\n");
    expect(image.mimeType).toBe("image/jpeg");
  });

  it("rejects truncated base64 data (e.g. from session cleanup)", async () => {
    const blocks = [
      {
        type: "image" as const,
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8\n[TRUNCATED from 65624 chars]",
        mimeType: "image/png",
      },
    ];

    const out = await sanitizeContentBlocksImages(blocks, "test");
    expect(out.length).toBe(1);
    expect(out[0].type).toBe("text");
    if (out[0].type === "text") {
      expect(out[0].text).toContain("invalid base64");
    }
  });

  it("rejects empty base64 data", async () => {
    const blocks = [
      {
        type: "image" as const,
        data: "   ",
        mimeType: "image/png",
      },
    ];

    const out = await sanitizeContentBlocksImages(blocks, "test");
    expect(out.length).toBe(1);
    expect(out[0].type).toBe("text");
    if (out[0].type === "text") {
      expect(out[0].text).toContain("omitted empty image");
    }
  });

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
});
