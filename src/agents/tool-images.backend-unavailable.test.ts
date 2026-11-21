// Tool image backend-unavailable tests cover safe pass-through when native
// image processing cannot load on constrained Linux/Termux platforms.
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  backendUnavailableError,
  imageOpsLoads,
  getImageMetadataMock,
  readImageMetadataFromHeaderMock,
} = vi.hoisted(() => ({
  backendUnavailableError: new Error("missing image backend"),
  imageOpsLoads: vi.fn(),
  getImageMetadataMock: vi.fn(),
  readImageMetadataFromHeaderMock: vi.fn(),
}));

const PNG_BASE64 = "iVBORw0KGgo=";

async function importSanitizer() {
  vi.resetModules();
  // mock-isolation: emulate an unavailable native backend and count lazy loads without initializing it.
  vi.doMock("../media/image-ops.js", () => {
    imageOpsLoads();
    return {
      IMAGE_REDUCE_QUALITY_STEPS: [85, 75],
      MAX_IMAGE_INPUT_PIXELS: 25_000_000,
      buildImageResizeSideGrid: () => [1200],
      getImageMetadata: getImageMetadataMock,
      isImageProcessorUnavailableError: (error: unknown) => error === backendUnavailableError,
      resizeToJpeg: async () => {
        throw backendUnavailableError;
      },
    };
  });
  // mock-isolation: Preserve fixture dimensions independently of the unavailable encoder.
  vi.doMock("../media/image-header-metadata.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../media/image-header-metadata.js")>()),
    readImageMetadataFromHeader: readImageMetadataFromHeaderMock,
  }));
  return await import("./tool-images.js");
}

describe("tool image sanitizer without native image backend", () => {
  beforeEach(() => {
    imageOpsLoads.mockClear();
    getImageMetadataMock.mockReset();
    readImageMetadataFromHeaderMock.mockReset();
  });

  it("loads image processing only when content needs image work", async () => {
    const { sanitizeContentBlocksImages } = await importSanitizer();
    const text = { type: "text" as const, text: "visible" };
    expect(await sanitizeContentBlocksImages([text], "test")).toEqual([text]);
    expect(await sanitizeContentBlocksImages([], "test")).toEqual([]);
    expect(imageOpsLoads).not.toHaveBeenCalled();

    readImageMetadataFromHeaderMock.mockReturnValueOnce({ width: 32, height: 24 });
    const image = { type: "image" as const, data: PNG_BASE64, mimeType: "image/png" };
    expect(await sanitizeContentBlocksImages([text, image], "test")).toEqual([text, image]);
    expect(imageOpsLoads).toHaveBeenCalledTimes(1);
  });

  it("keeps small header-verified images without probing the backend", async () => {
    readImageMetadataFromHeaderMock.mockReturnValueOnce({ width: 32, height: 24 });
    getImageMetadataMock.mockRejectedValueOnce(backendUnavailableError);
    const { sanitizeContentBlocksImages } = await importSanitizer();

    const out = await sanitizeContentBlocksImages(
      [{ type: "image" as const, data: PNG_BASE64, mimeType: "image/png" }],
      "test",
      { maxDimensionPx: 64, maxBytes: 1024 },
    );

    expect(out).toStrictEqual([{ type: "image", data: PNG_BASE64, mimeType: "image/png" }]);
    expect(getImageMetadataMock).not.toHaveBeenCalled();
  });

  it("does not pass through compressed images over the pixel cap", async () => {
    readImageMetadataFromHeaderMock.mockReturnValueOnce({ width: 6000, height: 6000 });
    const { sanitizeContentBlocksImages } = await importSanitizer();

    const out = await sanitizeContentBlocksImages(
      [{ type: "image" as const, data: PNG_BASE64, mimeType: "image/png" }],
      "test",
      { maxDimensionPx: 6000, maxBytes: 1024 },
    );

    expect(out).toStrictEqual([
      {
        type: "text",
        text: "[test] omitted image payload: Error: missing image backend",
      },
    ]);
  });
});
