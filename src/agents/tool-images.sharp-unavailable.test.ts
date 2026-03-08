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

// Known-good 1×1 transparent PNG (valid, ~54 decoded bytes — well under any size or dimension cap).
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAABjE+ibYAAAAASUVORK5CYII=";

/**
 * Builds a minimal PNG buffer whose IHDR declares the given dimensions.
 * The pixel data is intentionally omitted — only the header is needed for the passthrough check.
 */
function makePngWithDimensions(width: number, height: number): Buffer {
  // PNG signature (8) + IHDR chunk: length (4) + "IHDR" (4) + width (4) + height (4) + extras (5) + CRC (4)
  const buf = Buffer.alloc(33, 0);
  buf.write("\x89PNG\r\n\x1a\n", 0, "binary"); // PNG signature
  buf.writeUInt32BE(13, 8); // IHDR chunk data length = 13
  buf.write("IHDR", 12, "ascii"); // chunk type
  buf.writeUInt32BE(width, 16); // width
  buf.writeUInt32BE(height, 20); // height
  // bytes 24-28: bit depth, color type, compression, filter, interlace — left as 0
  // bytes 29-32: CRC — left as 0 (not validated by our header reader)
  return buf;
}

describe("sanitizeContentBlocksImages when sharp is unavailable", () => {
  it("passes through small PNGs within byte and dimension limits (dimensions verified via PNG IHDR)", async () => {
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

  it("surfaces an actionable error when PNG IHDR declares over-dimension and sharp cannot resize", async () => {
    // Under byte cap but declares 3000×3000 which exceeds the 1200px API limit.
    const overDimPng = makePngWithDimensions(3000, 3000);
    const blocks = [
      { type: "image" as const, data: overDimPng.toString("base64"), mimeType: "image/png" },
    ];
    const out = await sanitizeContentBlocksImages(blocks, "test");
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("text");
    if (out[0].type === "text") {
      expect(out[0].text).toMatch(/3000x3000/i);
      expect(out[0].text).toMatch(/sharp/i);
      expect(out[0].text).toMatch(/unavailable/i);
    }
  });
});
