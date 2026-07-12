// Tool image input-cap tests verify pathological oversized base64 input is
// rejected before Buffer.from allocates a transient multi-MB buffer.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { estimateMock, readImageMetadataFromHeaderMock } = vi.hoisted(() => ({
  estimateMock: vi.fn(),
  readImageMetadataFromHeaderMock: vi.fn(),
}));

const PNG_BASE64 = "iVBORw0KGgo=";

async function importSanitizer() {
  vi.resetModules();
  const actual = await vi.importActual("@openclaw/media-core/base64");
  vi.doMock("@openclaw/media-core/base64", () => ({
    ...actual,
    estimateBase64DecodedBytes: estimateMock,
  }));
  vi.doMock("../media/media-services.js", () => ({
    IMAGE_REDUCE_QUALITY_STEPS: [85, 75],
    MAX_IMAGE_INPUT_PIXELS: 25_000_000,
    buildImageResizeSideGrid: () => [1200],
    getImageMetadata: vi.fn(),
    isImageProcessorUnavailableError: () => false,
    readImageMetadataFromHeader: readImageMetadataFromHeaderMock,
    resizeToJpeg: vi.fn(),
  }));
  return await import("./tool-images.js");
}

describe("tool image sanitizer oversized input cap", () => {
  beforeEach(() => {
    estimateMock.mockReset();
    readImageMetadataFromHeaderMock.mockReset();
  });

  it("rejects oversized estimated input before decode allocation", async () => {
    // Estimate reports a decoded size far above the input hard cap; the real
    // allocator must never be reached for such pathological payloads.
    estimateMock.mockReturnValue(200 * 1024 * 1024);
    const { sanitizeContentBlocksImages } = await importSanitizer();

    const out = await sanitizeContentBlocksImages(
      [{ type: "image" as const, data: PNG_BASE64, mimeType: "image/png" }],
      "test",
    );

    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("text");
    expect((out[0] as { type: "text"; text: string }).text).toContain(
      "image exceeds input size limit",
    );
  });

  it("passes through small input under the cap", async () => {
    readImageMetadataFromHeaderMock.mockReturnValueOnce({ width: 32, height: 24 });
    estimateMock.mockReturnValue(1024);
    const { sanitizeContentBlocksImages } = await importSanitizer();

    const out = await sanitizeContentBlocksImages(
      [{ type: "image" as const, data: PNG_BASE64, mimeType: "image/png" }],
      "test",
      { maxDimensionPx: 64, maxBytes: 1024 },
    );

    expect(out).toStrictEqual([{ type: "image", data: PNG_BASE64, mimeType: "image/png" }]);
  });
});
