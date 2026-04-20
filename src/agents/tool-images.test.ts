import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  sanitizeContentBlocksImages,
  sanitizeImageBlocks,
  sanitizeToolResultImages,
} from "./tool-images.js";

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

  const createIsoBmffImage = (
    majorBrand: string,
    compatibleBrands: string[] = [],
    sizeMode: "fixed" | "extended" | "eof" = "fixed",
    minorVersion = "\0\0\0\0",
  ) => {
    const brands = [majorBrand, minorVersion, ...compatibleBrands];
    const payload = Buffer.concat(brands.map((brand) => Buffer.from(brand, "ascii")));
    if (sizeMode === "extended") {
      const size = Buffer.alloc(4);
      size.writeUInt32BE(1, 0);
      const extendedSize = Buffer.alloc(8);
      extendedSize.writeBigUInt64BE(BigInt(payload.length + 16), 0);
      return Buffer.concat([size, Buffer.from("ftyp", "ascii"), extendedSize, payload]);
    }
    if (sizeMode === "eof") {
      const size = Buffer.alloc(4);
      size.writeUInt32BE(0, 0);
      return Buffer.concat([size, Buffer.from("ftyp", "ascii"), payload]);
    }
    const size = Buffer.alloc(4);
    size.writeUInt32BE(payload.length + 8, 0);
    return Buffer.concat([size, Buffer.from("ftyp", "ascii"), payload]);
  };

  it("shrinks oversized images to the configured byte limit", async () => {
    const maxBytes = 128 * 1024;
    const width = 900;
    const height = 900;
    const raw = Buffer.alloc(width * height * 3, 0xff);
    const bigPng = await sharp(raw, {
      raw: { width, height, channels: 3 },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();
    expect(bigPng.byteLength).toBeGreaterThan(maxBytes);

    const blocks = [
      {
        type: "image" as const,
        data: bigPng.toString("base64"),
        mimeType: "image/png",
      },
    ];

    const out = await sanitizeContentBlocksImages(blocks, "test", { maxBytes });
    const image = getImageBlock(out);
    const size = Buffer.from(image.data, "base64").byteLength;
    expect(size).toBeLessThanOrEqual(maxBytes);
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

  it("drops malformed image base64 payloads", async () => {
    const blocks = [
      {
        type: "image" as const,
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2N4j8AAAAASUVORK5CYII=" onerror="alert(1)',
        mimeType: "image/png",
      },
    ];

    const out = await sanitizeContentBlocksImages(blocks, "test");
    expect(out).toEqual([
      {
        type: "text",
        text: "[test] omitted image payload: invalid base64",
      },
    ]);
  });

  it("drops HEIF tool-result image payloads before native decode", async () => {
    const heif = createIsoBmffImage("heic", ["mif1"]);
    const out = await sanitizeToolResultImages(
      {
        content: [{ type: "image", data: heif.toString("base64"), mimeType: "image/heif" }],
        details: {},
      },
      "test",
    );
    expect(out.content).toEqual([
      { type: "text", text: "[test] omitted image payload: Error: unsupported image format" },
    ]);
  });

  it("drops AVIF tool-result payloads even when mislabeled as jpeg", async () => {
    const avif = createIsoBmffImage("avif", ["mif1"]);
    const out = await sanitizeToolResultImages(
      {
        content: [{ type: "image", data: avif.toString("base64"), mimeType: "image/jpeg" }],
        details: {},
      },
      "test",
    );
    expect(out.content).toEqual([
      { type: "text", text: "[test] omitted image payload: Error: unsupported image format" },
    ]);
  });

  it("drops HEIF-family payloads detected only via compatible brand on tool results", async () => {
    const avif = createIsoBmffImage("mp41", ["mif1"]);
    const out = await sanitizeToolResultImages(
      {
        content: [{ type: "image", data: avif.toString("base64"), mimeType: "image/jpeg" }],
        details: {},
      },
      "test",
    );
    expect(out.content).toEqual([
      { type: "text", text: "[test] omitted image payload: Error: unsupported image format" },
    ]);
  });

  it("drops HEIF tool-result payloads using extended ftyp size", async () => {
    const heif = createIsoBmffImage("heic", ["mif1"], "extended");
    const out = await sanitizeToolResultImages(
      {
        content: [{ type: "image", data: heif.toString("base64"), mimeType: "image/jpeg" }],
        details: {},
      },
      "test",
    );
    expect(out.content).toEqual([
      { type: "text", text: "[test] omitted image payload: Error: unsupported image format" },
    ]);
  });

  it("drops HEIF tool-result payloads using zero-sized ftyp boxes", async () => {
    const avif = createIsoBmffImage("avif", ["mif1"], "eof");
    const out = await sanitizeToolResultImages(
      {
        content: [{ type: "image", data: avif.toString("base64"), mimeType: "image/jpeg" }],
        details: {},
      },
      "test",
    );
    expect(out.content).toEqual([
      { type: "text", text: "[test] omitted image payload: Error: unsupported image format" },
    ]);
  });

  it("drops HEIF compatible-brand payloads using extended ftyp size", async () => {
    const avif = createIsoBmffImage("mp41", ["mif1"], "extended");
    const out = await sanitizeToolResultImages(
      {
        content: [{ type: "image", data: avif.toString("base64"), mimeType: "image/jpeg" }],
        details: {},
      },
      "test",
    );
    expect(out.content).toEqual([
      { type: "text", text: "[test] omitted image payload: Error: unsupported image format" },
    ]);
  });

  it("drops mislabeled HEIF sequence-brand payloads before native decode", async () => {
    const hevx = createIsoBmffImage("hevx", ["mif1"]);
    const out = await sanitizeToolResultImages(
      {
        content: [{ type: "image", data: hevx.toString("base64"), mimeType: "image/jpeg" }],
        details: {},
      },
      "test",
    );
    expect(out.content).toEqual([
      { type: "text", text: "[test] omitted image payload: Error: unsupported image format" },
    ]);
  });

  it("does not treat extended ftyp minor version as a compatible brand", async () => {
    const mp4 = createIsoBmffImage("mp41", [], "extended", "heic");
    const out = await sanitizeToolResultImages(
      {
        content: [{ type: "image", data: mp4.toString("base64"), mimeType: "image/jpeg" }],
        details: {},
      },
      "test",
    );
    expect(out.content).toEqual([
      {
        type: "text",
        text: "[test] omitted image payload: Error: Input buffer contains unsupported image format",
      },
    ]);
  });

  it("lets callers opt out of HEIF rejection for user-authorized reads", async () => {
    const heif = createIsoBmffImage("heic", ["mif1"]);
    const out = await sanitizeToolResultImages(
      {
        content: [{ type: "image", data: heif.toString("base64"), mimeType: "image/heic" }],
        details: {},
      },
      "test",
      { rejectHeifFamily: false },
    );
    const block = out.content[0];
    if (block && block.type === "text") {
      expect(block.text).not.toBe("[test] omitted image payload: Error: unsupported image format");
    }
    expect(out.details).toMatchObject({
      imageSanitization: {
        rejectHeifFamily: false,
      },
    });
  });
});
