// Tool image tests cover image payload sanitization before tool outputs are
// returned to model-visible content blocks.
import { beforeEach, describe, expect, it } from "vitest";
import {
  createNoisyPngBuffer,
  createSolidPngBuffer,
  createTinyJpegBuffer,
} from "../../test/helpers/image-fixtures.js";
import { getImageMetadata } from "../media/image-ops.js";
import {
  __testing,
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
    return createSolidPngBuffer(420, 120, { r: 0x7f, g: 0x7f, b: 0x7f });
  };

  beforeEach(() => {
    __testing.resetResizeCache();
  });

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

  it("uses default image limits for non-finite options", async () => {
    const jpeg = createTinyJpegBuffer();

    const out = await sanitizeContentBlocksImages(
      [
        {
          type: "image" as const,
          data: jpeg.toString("base64"),
          mimeType: "image/jpeg",
        },
      ],
      "test",
      { maxDimensionPx: Number.NaN, maxBytes: Number.NaN },
    );

    const image = getImageBlock(out);
    expect(image.mimeType).toBe("image/jpeg");
    expect(image.data).toBe(jpeg.toString("base64"));
  });

  it("preserves data and mimeType on no-resize path", async () => {
    const png = createSolidPngBuffer(10, 10, { r: 0, g: 0, b: 255 });
    const base64 = png.toString("base64");

    const blocks = [{ type: "image" as const, data: base64, mimeType: "image/png" }];
    const out = await sanitizeContentBlocksImages(blocks, "test");
    expect(out).toHaveLength(1);
    const image = getImageBlock(out);
    expect(typeof image.data).toBe("string");
    expect(image.data.length).toBeGreaterThan(0);
    expect(typeof image.mimeType).toBe("string");
    expect(image.mimeType).toBe("image/png");
  });

  it("preserves data and mimeType on resize path", async () => {
    const png = createSolidPngBuffer(2600, 400, { r: 255, g: 0, b: 0 });
    const base64 = png.toString("base64");

    const blocks = [{ type: "image" as const, data: base64, mimeType: "image/png" }];
    const out = await sanitizeContentBlocksImages(blocks, "test");
    expect(out).toHaveLength(1);
    const image = getImageBlock(out);
    expect(typeof image.data).toBe("string");
    expect(image.data.length).toBeGreaterThan(0);
    expect(typeof image.mimeType).toBe("string");
  }, 20_000);

  it("converts image blocks with missing data/mimeType to text", async () => {
    const blocks = [
      {
        type: "image" as const,
        data: undefined as unknown as string,
        mimeType: undefined as unknown as string,
      },
    ];
    const out = await sanitizeContentBlocksImages(blocks, "browser:screenshot");
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("text");
    expect((out[0] as { type: "text"; text: string }).text).toContain("missing data or mimeType");
  });

  it("screenshot-shaped tool result round-trips with valid image block", async () => {
    const png = createSolidPngBuffer(100, 100, { r: 0, g: 128, b: 0 });
    const base64 = png.toString("base64");

    const result = {
      content: [{ type: "image" as const, data: base64, mimeType: "image/png" }],
      details: { path: "/tmp/screenshot.png" },
    };
    const sanitized = await sanitizeToolResultImages(result, "browser:screenshot");
    const imageBlock = sanitized.content.find((b) => b.type === "image");
    expect(imageBlock).toBeDefined();
    expect(typeof (imageBlock as { data: string }).data).toBe("string");
    expect((imageBlock as { data: string }).data.length).toBeGreaterThan(0);
    expect(typeof (imageBlock as { mimeType: string }).mimeType).toBe("string");
  });

  it("screenshot-shaped tool result with malformed image produces text fallback", async () => {
    const result = {
      content: [
        {
          type: "image" as const,
          data: undefined as unknown as string,
          mimeType: undefined as unknown as string,
        },
      ],
      details: {},
    };
    const sanitized = await sanitizeToolResultImages(result, "browser:screenshot");
    const imageBlocks = sanitized.content.filter((b) => b.type === "image");
    expect(imageBlocks).toHaveLength(0);
    const textFallback = sanitized.content.find(
      (b) => b.type === "text" && (b as { text: string }).text.includes("missing data or mimeType"),
    );
    expect(textFallback).toBeDefined();
  });

  it("drops malformed image base64 payloads", async () => {
    // Invalid base64 is replaced with text so malformed payloads cannot smuggle
    // attributes or script-like text through image blocks.
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

  describe("resize cache (#64418)", () => {
    it("reuses the resize result for the same image across repeated calls", async () => {
      // Simulates session history being re-sanitized on every turn.
      const png = await createWidePng();
      const block = {
        type: "image" as const,
        data: png.toString("base64"),
        mimeType: "image/png",
      };

      const firstCall = await sanitizeContentBlocksImages([block], "turn-1");
      const statsAfterFirst = __testing.getResizeCacheStats();
      expect(statsAfterFirst.misses).toBe(1);
      expect(statsAfterFirst.hits).toBe(0);
      expect(statsAfterFirst.entryCount).toBe(1);

      const secondCall = await sanitizeContentBlocksImages([block], "turn-2");
      const statsAfterSecond = __testing.getResizeCacheStats();
      expect(statsAfterSecond.misses).toBe(1);
      expect(statsAfterSecond.hits).toBe(1);

      const first = getImageBlock(firstCall);
      const second = getImageBlock(secondCall);
      expect(second.data).toBe(first.data);
      expect(second.mimeType).toBe(first.mimeType);
    }, 20_000);

    it("keys on the full base64 payload so long shared prefixes do not collide (#64514 P1)", () => {
      const sharedPrefix = "A".repeat(1024);
      const base64A = `${sharedPrefix}aaaaBBBBcccc`;
      const base64B = `${sharedPrefix}aaaaDDDDcccc`;
      expect(base64A.slice(0, 1024)).toBe(base64B.slice(0, 1024));
      expect(base64A).not.toBe(base64B);

      const maxDimensionPx = 1200;
      const maxBytes = 5 * 1024 * 1024;
      const keyA = __testing.computeResizeCacheKey(base64A, maxDimensionPx, maxBytes);
      const keyB = __testing.computeResizeCacheKey(base64B, maxDimensionPx, maxBytes);
      expect(keyA).not.toBe(keyB);

      // Sanity: the same payload hashes to the same key and limits are part
      // of the key space.
      expect(__testing.computeResizeCacheKey(base64A, maxDimensionPx, maxBytes)).toBe(keyA);
      expect(__testing.computeResizeCacheKey(base64A, maxDimensionPx + 1, maxBytes)).not.toBe(keyA);
      expect(__testing.computeResizeCacheKey(base64A, maxDimensionPx, maxBytes + 1)).not.toBe(keyA);
    });

    it("preserves the caller's mimeType on a no-op cache hit (#68677 review feedback)", async () => {
      // WebP falls outside inferMimeTypeFromBase64's JPEG/PNG/GIF
      // canonicalization list, so the helper receives and must preserve the
      // caller's declared MIME on no-op cache hits.
      // 1x1 valid WebP. Keep inline so this unit-fast test does not depend on
      // optional image backends just to build a fixture.
      const base64 = "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA";
      const limits = { maxDimensionPx: 1200, maxBytes: 5 * 1024 * 1024 };

      const firstResult = await __testing.resizeImageBase64IfNeeded({
        base64,
        mimeType: "image/webp",
        ...limits,
      });
      expect(firstResult.resized).toBe(false);
      expect(firstResult.mimeType).toBe("image/webp");
      expect(__testing.getResizeCacheStats()).toMatchObject({ misses: 1, hits: 0 });

      const secondResult = await __testing.resizeImageBase64IfNeeded({
        base64,
        mimeType: "image/heic",
        ...limits,
      });
      expect(__testing.getResizeCacheStats()).toMatchObject({ misses: 1, hits: 1 });
      expect(secondResult.resized).toBe(false);
      expect(secondResult.mimeType).toBe("image/heic");
      expect(secondResult.base64).toBe(base64);
    }, 20_000);

    it("records separate cache entries for two distinct valid images (#64418 end-to-end)", async () => {
      const width = 400;
      const height = 400;
      const jpegA = createSolidPngBuffer(width, height, { r: 0xff, g: 0x00, b: 0x00 });
      const jpegB = createSolidPngBuffer(width, height, { r: 0x00, g: 0x00, b: 0xff });
      expect(jpegA.equals(jpegB)).toBe(false);

      await sanitizeContentBlocksImages(
        [{ type: "image" as const, data: jpegA.toString("base64"), mimeType: "image/png" }],
        "A",
      );
      await sanitizeContentBlocksImages(
        [{ type: "image" as const, data: jpegB.toString("base64"), mimeType: "image/png" }],
        "B",
      );

      const stats = __testing.getResizeCacheStats();
      expect(stats.misses).toBe(2);
      expect(stats.hits).toBe(0);
      expect(stats.entryCount).toBe(2);
    }, 20_000);

    it("keys the cache by maxBytes so different limits do not share results", async () => {
      const png = await createWidePng();
      const block = {
        type: "image" as const,
        data: png.toString("base64"),
        mimeType: "image/png",
      };

      await sanitizeContentBlocksImages([block], "small-limit", { maxBytes: 64 * 1024 });
      await sanitizeContentBlocksImages([block], "large-limit", { maxBytes: 256 * 1024 });
      const stats = __testing.getResizeCacheStats();
      expect(stats.misses).toBe(2);
      expect(stats.hits).toBe(0);
      expect(stats.entryCount).toBe(2);
    }, 20_000);

    it("bounds cache memory by evicting past the byte cap", async () => {
      __testing.setResizeCacheMaxBytesForTests(1);
      const png = await createWidePng();
      const base64 = png.toString("base64");

      for (const limit of [64 * 1024, 96 * 1024, 128 * 1024]) {
        await sanitizeContentBlocksImages(
          [{ type: "image" as const, data: base64, mimeType: "image/png" }],
          `limit-${limit}`,
          { maxBytes: limit },
        );
      }

      const stats = __testing.getResizeCacheStats();
      expect(stats.totalBytes).toBeLessThanOrEqual(stats.maxBytes);
      expect(stats.misses).toBe(3);
      expect(stats.entryCount).toBe(0);
    }, 30_000);
  });
});
