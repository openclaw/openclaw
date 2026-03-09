import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  buildImageResizeSideGrid,
  IMAGE_REDUCE_QUALITY_STEPS,
  isAnimatedImage,
} from "./image-ops.js";

describe("buildImageResizeSideGrid", () => {
  it("returns descending unique sides capped by maxSide", () => {
    expect(buildImageResizeSideGrid(1200, 900)).toEqual([1200, 1000, 900, 800]);
  });

  it("keeps only positive side values", () => {
    expect(buildImageResizeSideGrid(0, 0)).toEqual([]);
  });
});

describe("IMAGE_REDUCE_QUALITY_STEPS", () => {
  it("keeps expected quality ladder", () => {
    expect([...IMAGE_REDUCE_QUALITY_STEPS]).toEqual([85, 75, 65, 55, 45, 35]);
  });
});

describe("isAnimatedImage", () => {
  it("returns false for static GIF (single frame)", async () => {
    // Note: Creating true multi-frame animated GIFs with sharp programmatically
    // is complex. This test verifies single-frame images return false.
    // Animated image detection is also tested via integration in web/media.test.ts
    const staticGif = await sharp({
      create: { width: 10, height: 10, channels: 3, background: "#ff0000" },
    })
      .gif()
      .toBuffer();

    expect(await isAnimatedImage(staticGif)).toBe(false);
  });

  it("returns false for static JPEG", async () => {
    const jpeg = await sharp({
      create: { width: 10, height: 10, channels: 3, background: "#ff0000" },
    })
      .jpeg()
      .toBuffer();

    expect(await isAnimatedImage(jpeg)).toBe(false);
  });

  it("returns false for static PNG", async () => {
    const png = await sharp({
      create: { width: 10, height: 10, channels: 3, background: "#ff0000" },
    })
      .png()
      .toBuffer();

    expect(await isAnimatedImage(png)).toBe(false);
  });

  it("returns false for static WebP", async () => {
    const webp = await sharp({
      create: { width: 10, height: 10, channels: 3, background: "#ff0000" },
    })
      .webp()
      .toBuffer();

    expect(await isAnimatedImage(webp)).toBe(false);
  });

  it("returns false for invalid/corrupt data", async () => {
    const garbage = Buffer.from("not an image at all");
    expect(await isAnimatedImage(garbage)).toBe(false);
  });

  it("returns false for empty buffer", async () => {
    expect(await isAnimatedImage(Buffer.alloc(0))).toBe(false);
  });
});
