import { beforeEach, describe, expect, it, vi } from "vitest";

const resizeToJpegMock = vi.fn();

vi.mock("./image-ops.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./image-ops.js")>();
  return {
    ...actual,
    resizeToJpeg: resizeToJpegMock,
  };
});

describe("optimizeImageToJpeg", () => {
  beforeEach(() => {
    resizeToJpegMock.mockReset();
  });

  it("surfaces the underlying resize failure when all optimization attempts fail", async () => {
    const cause = new Error("Cannot find package 'sharp'");
    resizeToJpegMock.mockRejectedValue(cause);
    const { optimizeImageToJpeg } = await import("./web-media.js");

    await expect(optimizeImageToJpeg(Buffer.from("not-an-image"), 1024)).rejects.toThrow(
      "Failed to optimize image: Cannot find package 'sharp'",
    );
    await expect(optimizeImageToJpeg(Buffer.from("not-an-image"), 1024)).rejects.toMatchObject({
      cause,
    });
  });
});
