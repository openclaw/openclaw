import { describe, expect, it } from "vitest";
import { loadWebMedia, optimizeImageBufferForWebMedia } from "./web-media.js";

const ANIMATED_WEBP_BUFFER = Buffer.from(
  "UklGRuQAAABXRUJQVlA4WAoAAAACAAAAFwAAFwAAQU5JTQYAAAD/////AABBTk1GWAAAAAAAAAAAABcAABcAAFAAAAJWUDggQAAAAHADAJ0BKhgAGAA+bTSWR6QjIiEoCACADYllAMougH4AAEGUEAD+8JtD/8guWF1yNf/yA/5Af8gP/499jCgwAABBTk1GWAAAAAAAAAAAABcAABcAAHgAAABWUDggQAAAAFQDAJ0BKhgAGAA+bTKWR4KAgAAA2JZQC/ZoB+AH4AAETfZgAP7lhz/9rQHBqv8z//998KI7df5tQBnBY0gAAAA=",
  "base64",
);

describe("animated WebP delivery", () => {
  it.each(["untyped", "local"] as const)(
    "preserves animated WebP frames above the preferred size through the %s owner",
    async (owner) => {
      const imageCompression = { models: [{ preferredSidePx: 12 }] };
      const result =
        owner !== "local"
          ? await optimizeImageBufferForWebMedia({
              buffer: ANIMATED_WEBP_BUFFER,
              fileName: "animated.webp",
              maxBytes: 1024,
              imageCompression,
            })
          : await loadWebMedia("/virtual/animated.webp", {
              maxBytes: 1024,
              sandboxValidated: true,
              readFile: async () => ANIMATED_WEBP_BUFFER,
              imageCompression,
            });
      expect(result).toMatchObject({
        contentType: "image/webp",
        kind: "image",
        fileName: "animated.webp",
      });
      expect(result.buffer.equals(ANIMATED_WEBP_BUFFER)).toBe(true);
    },
  );

  it.each([
    { limits: { maxSidePx: 12 }, constraint: "side" },
    { limits: { maxPixels: 144 }, constraint: "pixel" },
  ] as const)(
    "rejects animated WebP hard $constraint limits through the local loader",
    async ({ limits }) => {
      const imageCompression = { models: [limits] };
      const result = loadWebMedia("/virtual/animated.webp", {
        maxBytes: 1024,
        sandboxValidated: true,
        readFile: async () => ANIMATED_WEBP_BUFFER,
        imageCompression,
      });
      await expect(result).rejects.toThrow(/dimensions exceed model image limits/i);
    },
  );

  it("rejects animated WebP beyond the byte cap through the local loader", async () => {
    const repeatedFrame = ANIMATED_WEBP_BUFFER.subarray(44, 140);
    const oversized = Buffer.concat([
      ANIMATED_WEBP_BUFFER,
      ...Array.from({ length: 12 }, () => repeatedFrame),
    ]);
    oversized.writeUInt32LE(oversized.length - 8, 4);
    const result = loadWebMedia("/virtual/animated.webp", {
      maxBytes: 1024,
      sandboxValidated: true,
      readFile: async () => oversized,
    });
    await expect(result).rejects.toMatchObject({
      name: "ImageOptimizationLimitError",
      maxBytes: 1024,
    });
  });
});
