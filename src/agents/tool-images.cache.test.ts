import { beforeEach, expect, it, vi } from "vitest";

const { resize } = vi.hoisted(() => ({ resize: vi.fn() }));
vi.mock("../media/media-services.js", () => ({
  buildImageResizeSideGrid: () => [1200],
  getImageMetadata: vi.fn(),
  IMAGE_REDUCE_QUALITY_STEPS: [85],
  isImageProcessorUnavailableError: () => false,
  MAX_IMAGE_INPUT_PIXELS: 25_000_000,
  readImageMetadataFromHeader: () => ({ width: 1600, height: 1200 }),
  resizeToJpeg: resize,
}));
let sanitize: typeof import("./tool-images.js").sanitizeImageBlocks;
const image = (value: string) => ({
  type: "image" as const,
  data: Buffer.from(value).toString("base64"),
  mimeType: "image/png",
});
beforeEach(async () => {
  vi.resetModules();
  resize.mockReset().mockResolvedValue(Buffer.alloc(100, 2));
  sanitize = (await import("./tool-images.js")).sanitizeImageBlocks;
});

it("replays identical resized bytes across detached history reads without recompressing", async () => {
  const source = image("history image");
  const first = await sanitize([source], "prompt:images");
  const replay = await sanitize([{ ...source }], "session:history");
  expect(replay).toEqual(first);
  expect(resize).toHaveBeenCalledTimes(1);
  expect(source.data).toBe(image("history image").data);
  await sanitize([image("changed image")], "prompt:images");
  await sanitize([source], "prompt:images", { maxDimensionPx: 800 });
  await sanitize([source], "prompt:images", { maxBytes: 500 });
  await sanitize([{ ...source, mimeType: "image/webp" }], "prompt:images");
  expect(resize).toHaveBeenCalledTimes(5);
});

it("retries failed transforms and never reuses a result for a stricter byte cap", async () => {
  const source = image("retry image");
  resize.mockRejectedValueOnce(new Error("processor failed"));
  expect((await sanitize([source], "prompt:images")).dropped).toBe(1);
  expect((await sanitize([source], "prompt:images")).dropped).toBe(0);
  expect((await sanitize([source], "prompt:images", { maxBytes: 50 })).dropped).toBe(1);
  expect(resize).toHaveBeenCalledTimes(3);
});

it("bounds retained transforms by both count and bytes", async () => {
  for (let index = 0; index <= 64; index++) {
    await sanitize([image(`small ${index}`)], "prompt:images");
  }
  await sanitize([image("small 0")], "prompt:images");
  expect(resize).toHaveBeenCalledTimes(66);
  resize.mockResolvedValue(Buffer.alloc(5 * 1024 * 1024, 2));
  await sanitize([image("large first")], "prompt:images");
  await sanitize([image("large second")], "prompt:images");
  await sanitize([image("large third")], "prompt:images");
  await sanitize([image("large first")], "prompt:images");
  expect(resize).toHaveBeenCalledTimes(70);
});
