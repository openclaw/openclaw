import { describe, expect, it, vi } from "vitest";
import { SharpUnavailableError } from "../media/image-ops.js";
import { sanitizeContentBlocksImages } from "./tool-images.js";

// Simulate a host where the sharp native module cannot load (e.g., CPU lacking SSE4.2).
vi.mock("../media/image-ops.js", async () => {
  const actual =
    await vi.importActual<typeof import("../media/image-ops.js")>("../media/image-ops.js");
  return {
    ...actual,
    getImageMetadata: () => Promise.resolve(null),
    isSharpAvailable: () => false,
    resizeToJpeg: () => {
      throw new SharpUnavailableError(new Error("CPU incompatible with sharp"));
    },
  };
});

// Known-good 1×1 transparent PNG (valid, ~54 decoded bytes — well under any size cap).
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAABjE+ibYAAAAASUVORK5CYII=";

describe("sanitizeContentBlocksImages when sharp is unavailable", () => {
  it("passes through small PNGs already within byte and dimension limits", async () => {
    const blocks = [{ type: "image" as const, data: TINY_PNG_B64, mimeType: "image/png" }];
    const out = await sanitizeContentBlocksImages(blocks, "test");
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("image");
    if (out[0].type === "image") {
      // Data should be unchanged — no re-encoding
      expect(out[0].data).toBe(TINY_PNG_B64);
      expect(out[0].mimeType).toBe("image/png");
    }
  });

  it("surfaces an actionable error when image exceeds the byte cap and sharp cannot resize", async () => {
    // Build a >5 MB buffer with PNG magic bytes at the front so it looks like a PNG.
    const largeBytes = Buffer.alloc(6 * 1024 * 1024, 0);
    largeBytes.write("\x89PNG\r\n\x1a\n", 0, "binary");
    const blocks = [
      { type: "image" as const, data: largeBytes.toString("base64"), mimeType: "image/png" },
    ];
    const out = await sanitizeContentBlocksImages(blocks, "test");
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("text");
    if (out[0].type === "text") {
      // Error message should mention sharp and be actionable.
      expect(out[0].text).toMatch(/sharp/i);
      expect(out[0].text).toMatch(/unavailable/i);
    }
  });
});
