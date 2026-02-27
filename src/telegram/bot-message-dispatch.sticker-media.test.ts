import { describe, expect, it } from "vitest";
import { pruneStickerMediaFromContext } from "./bot-message-dispatch.js";

describe("pruneStickerMediaFromContext", () => {
  it("preserves appended reply media while removing primary sticker media", () => {
    const ctx = {
      MediaPath: "/tmp/sticker.webp",
      MediaUrl: "/tmp/sticker.webp",
      MediaType: "image/webp",
      MediaPaths: ["/tmp/sticker.webp", "/tmp/replied.jpg"],
      MediaUrls: ["/tmp/sticker.webp", "/tmp/replied.jpg"],
      MediaTypes: ["image/webp", "image/jpeg"],
    };

    pruneStickerMediaFromContext(ctx);

    expect(ctx.MediaPath).toBe("/tmp/replied.jpg");
    expect(ctx.MediaUrl).toBe("/tmp/replied.jpg");
    expect(ctx.MediaType).toBe("image/jpeg");
    expect(ctx.MediaPaths).toEqual(["/tmp/replied.jpg"]);
    expect(ctx.MediaUrls).toEqual(["/tmp/replied.jpg"]);
    expect(ctx.MediaTypes).toEqual(["image/jpeg"]);
  });

  it("clears media fields when sticker is the only media", () => {
    const ctx = {
      MediaPath: "/tmp/sticker.webp",
      MediaUrl: "/tmp/sticker.webp",
      MediaType: "image/webp",
      MediaPaths: ["/tmp/sticker.webp"],
      MediaUrls: ["/tmp/sticker.webp"],
      MediaTypes: ["image/webp"],
    };

    pruneStickerMediaFromContext(ctx);

    expect(ctx.MediaPath).toBeUndefined();
    expect(ctx.MediaUrl).toBeUndefined();
    expect(ctx.MediaType).toBeUndefined();
    expect(ctx.MediaPaths).toBeUndefined();
    expect(ctx.MediaUrls).toBeUndefined();
    expect(ctx.MediaTypes).toBeUndefined();
  });

  it("does not prune when sticker media is already omitted from context", () => {
    const ctx = {
      MediaPath: "/tmp/replied.jpg",
      MediaUrl: "/tmp/replied.jpg",
      MediaType: "image/jpeg",
      MediaPaths: ["/tmp/replied.jpg"],
      MediaUrls: ["/tmp/replied.jpg"],
      MediaTypes: ["image/jpeg"],
    };

    pruneStickerMediaFromContext(ctx, { stickerMediaIncluded: false });

    expect(ctx.MediaPath).toBe("/tmp/replied.jpg");
    expect(ctx.MediaUrl).toBe("/tmp/replied.jpg");
    expect(ctx.MediaType).toBe("image/jpeg");
    expect(ctx.MediaPaths).toEqual(["/tmp/replied.jpg"]);
    expect(ctx.MediaUrls).toEqual(["/tmp/replied.jpg"]);
    expect(ctx.MediaTypes).toEqual(["image/jpeg"]);
  });
});
