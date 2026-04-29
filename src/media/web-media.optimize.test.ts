import { beforeEach, describe, expect, it, vi } from "vitest";

const resizeToJpegMock = vi.fn();
const convertHeicToJpegMock = vi.fn();
const optimizeImageToPngMock = vi.fn();
const hasAlphaChannelMock = vi.fn();

vi.mock("./image-ops.js", () => ({
  convertHeicToJpeg: (...args: unknown[]) => convertHeicToJpegMock(...args),
  hasAlphaChannel: (...args: unknown[]) => hasAlphaChannelMock(...args),
  optimizeImageToPng: (...args: unknown[]) => optimizeImageToPngMock(...args),
  resizeToJpeg: (...args: unknown[]) => resizeToJpegMock(...args),
}));

let optimizeImageToJpeg: typeof import("./web-media.js").optimizeImageToJpeg;

beforeEach(async () => {
  vi.clearAllMocks();
  ({ optimizeImageToJpeg } = await import("./web-media.js"));
});

describe("optimizeImageToJpeg", () => {
  it("falls back to the original buffer when all optimization attempts fail", async () => {
    const original = Buffer.from("not-decodable-by-image-backends");
    resizeToJpegMock.mockRejectedValue(new Error("sharp is unavailable"));

    const result = await optimizeImageToJpeg(original, 1024 * 1024, {
      contentType: "image/png",
      fileName: "broken.png",
    });

    expect(result).toEqual({
      buffer: original,
      optimizedSize: original.length,
      resizeSide: 0,
      quality: 0,
    });
    expect(resizeToJpegMock).toHaveBeenCalledTimes(25);
  });

  it("still returns the smallest optimized buffer when every attempt exceeds the cap", async () => {
    const original = Buffer.from("original-image");
    const large = Buffer.alloc(10, 1);
    const smallest = Buffer.alloc(5, 2);
    resizeToJpegMock.mockResolvedValueOnce(large).mockResolvedValue(smallest);

    const result = await optimizeImageToJpeg(original, 1);

    expect(result).toEqual({
      buffer: smallest,
      optimizedSize: smallest.length,
      resizeSide: 2048,
      quality: 70,
    });
    expect(resizeToJpegMock).toHaveBeenCalledTimes(25);
  });
});
