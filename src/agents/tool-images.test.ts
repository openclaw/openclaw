import { describe, expect, it, vi } from "vitest";
import {
  createNoisyPngBuffer,
  createSolidPngBuffer,
  createTinyJpegBuffer,
} from "../../test/helpers/image-fixtures.js";
import { getImageMetadata } from "../media/image-ops.js";
import { sanitizeContentBlocksImages, sanitizeImageBlocks } from "./tool-images.js";

describe("tool image sanitizing", () => {
  async function withUnavailableImageBackend<T>(fn: () => Promise<T>): Promise<T> {
    vi.resetModules();
    vi.doMock("../media/media-services.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../media/media-services.js")>()),
      getImageMetadata: vi.fn(async () => ({ width: 420, height: 120 })),
      isImageProcessorUnavailableError: (err: unknown) =>
        err instanceof Error && /image processor unavailable/i.test(err.message),
      resizeToJpeg: vi.fn(async () => {
        throw new Error("Image processor unavailable for resizeToJpeg");
      }),
    }));
    try {
      return await fn();
    } finally {
      vi.doUnmock("../media/media-services.js");
      vi.resetModules();
    }
  }

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
    return createSolidPngBuffer(420, 120, { r: 0x7f, g: 0x7f, b: 0x7f });
  };

  it("shrinks oversized images to the configured byte limit", async () => {
    const maxBytes = 64 * 1024;
    const width = 300;
    const height = 300;
    const bigPng = createNoisyPngBuffer(width, height);
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
    const { images: out, dropped } = await sanitizeImageBlocks(images, "test", {
      maxDimensionPx: 120,
    });
    expect(dropped).toBe(0);
    expect(out.length).toBe(1);
    const meta = await getImageMetadata(Buffer.from(out[0].data, "base64"));
    expect(meta?.width).toBeLessThanOrEqual(120);
    expect(meta?.height).toBeLessThanOrEqual(120);
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

    const out = await sanitizeContentBlocksImages(blocks, "test", { maxDimensionPx: 120 });
    const image = getImageBlock(out);
    const meta = await getImageMetadata(Buffer.from(image.data, "base64"));
    expect(meta?.width).toBeLessThanOrEqual(120);
    expect(meta?.height).toBeLessThanOrEqual(120);
    expect(image.mimeType).toBe("image/jpeg");
  }, 20_000);

  it("drops images above max dimension when no image processor is available", async () => {
    const png = await createWidePng();
    expect(png.byteLength).toBeLessThan(5 * 1024 * 1024);

    const blocks = [
      {
        type: "image" as const,
        data: png.toString("base64"),
        mimeType: "image/png",
      },
    ];

    const out = await withUnavailableImageBackend(async () => {
      const { sanitizeContentBlocksImages: sanitizeWithMissingOptimizer } =
        await import("./tool-images.js");
      return await sanitizeWithMissingOptimizer(blocks, "test", { maxDimensionPx: 120 });
    });

    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("text");
    if (out[0].type === "text") {
      expect(out[0].text).toMatch(/image processor unavailable/i);
    }
  }, 20_000);

  it("corrects mismatched jpeg mimeType", async () => {
    const jpeg = createTinyJpegBuffer();

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
});
