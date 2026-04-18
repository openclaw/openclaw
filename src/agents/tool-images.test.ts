import sharp from "sharp";
import { beforeEach, describe, expect, it } from "vitest";
import { __testing, sanitizeContentBlocksImages, sanitizeImageBlocks } from "./tool-images.js";

describe("tool image sanitizing", () => {
  beforeEach(() => {
    __testing.resetResizeCache();
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
      // Direct regression guard against the #64514 P1 bug: hashing only a
      // prefix of the base64 payload (e.g. `base64.slice(0, 1000)`) causes
      // two distinct images that share a long leading prefix to produce the
      // same key, silently substituting one image's bytes for another in
      // the session context. We build two payloads whose first 1024 chars
      // are byte-identical and assert that `computeResizeCacheKey` still
      // distinguishes them. Any key strategy that truncates the base64 at
      // 1000 chars or fewer will fail this.
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

    it("records separate cache entries for two distinct valid images (#64418 end-to-end)", async () => {
      // Behavior-level guard that the outer wrapper actually routes distinct
      // images through distinct cache entries. Two different JPEGs share
      // their leading JPEG headers (SOI/APP0/DQT) but diverge in the
      // compressed data; if the wrapper ever keyed on only the prefix, we
      // would see 1 miss + 1 hit instead of 2 misses + 2 entries.
      const width = 400;
      const height = 400;
      const redRaw = Buffer.alloc(width * height * 3);
      const blueRaw = Buffer.alloc(width * height * 3);
      for (let i = 0; i < redRaw.length; i += 3) {
        redRaw[i] = 0xff;
        blueRaw[i + 2] = 0xff;
      }
      const jpegA = await sharp(redRaw, { raw: { width, height, channels: 3 } })
        .jpeg({ quality: 80 })
        .toBuffer();
      const jpegB = await sharp(blueRaw, { raw: { width, height, channels: 3 } })
        .jpeg({ quality: 80 })
        .toBuffer();
      expect(jpegA.equals(jpegB)).toBe(false);

      await sanitizeContentBlocksImages(
        [{ type: "image" as const, data: jpegA.toString("base64"), mimeType: "image/jpeg" }],
        "A",
      );
      await sanitizeContentBlocksImages(
        [{ type: "image" as const, data: jpegB.toString("base64"), mimeType: "image/jpeg" }],
        "B",
      );

      const stats = __testing.getResizeCacheStats();
      // Two distinct payloads, two distinct misses, two distinct entries.
      // With a colliding key this would be 1 miss + 1 hit + 1 entry.
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
      // Size the cap at 1 byte so every insert forces immediate eviction;
      // this deterministically proves the eviction loop runs regardless of
      // what sharp happens to produce for a given input.
      __testing.setResizeCacheMaxBytes(1);
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
      // All three inserts happened (three distinct keys) but each was evicted
      // immediately because the new entry's own size exceeded the 1-byte cap.
      expect(stats.misses).toBe(3);
      expect(stats.entryCount).toBe(0);
    }, 30_000);
  });
});
