import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  convertImageToPng: vi.fn(),
  encode: vi.fn(),
  probe: vi.fn(),
}));

vi.mock("../../media/image-ops.js", () => ({
  convertImageToPng: mocks.convertImageToPng,
  createImageProcessor: () => ({
    encode: mocks.encode,
    probe: mocks.probe,
  }),
}));

import { processImage } from "./image-resize.js";

const output = Buffer.from("encoded image");
const encoded = {
  data: output,
  height: 20,
  mimeType: "image/jpeg",
  resized: false,
  width: 10,
  withinBudget: true,
};

function resize(data: Buffer, mimeType = "image/png") {
  return processImage({ data, mimeType }, { autoResizeImages: true });
}

function success(data: Buffer, mimeType: string, hints: string[] = []) {
  return { ok: true, image: { type: "image", data: data.toString("base64"), mimeType }, hints };
}

describe("image resize utility", () => {
  beforeEach(() => {
    mocks.convertImageToPng.mockReset();
    mocks.encode.mockReset();
    mocks.probe.mockReset();
    mocks.probe.mockResolvedValue({ height: 20, orientation: null, width: 10 });
    mocks.encode.mockResolvedValue(encoded);
  });

  it("keeps images that exactly fit the inline limits", async () => {
    const input = Buffer.alloc(((4.5 * 1024 * 1024) / 4) * 3);
    expect(await resize(input)).toStrictEqual(success(input, "image/png"));
    expect(mocks.encode).not.toHaveBeenCalled();
  });

  it("uses Rastermill limits, base64 budget, and orientation-aware source dimensions", async () => {
    const inputBuffer = Buffer.from("large image");
    mocks.probe.mockResolvedValue({ height: 1200, orientation: 6, width: 3000 });
    mocks.encode.mockResolvedValue({ ...encoded, height: 1600, resized: true, width: 640 });

    const result = await resize(inputBuffer, "image/jpeg");

    expect(mocks.encode).toHaveBeenCalledWith(inputBuffer, {
      format: "auto",
      limits: { maxHeight: 2_000, maxWidth: 2_000 },
      maxBase64Bytes: 4.5 * 1024 * 1024,
      opaque: { format: "jpeg", quality: 80 },
      search: {
        compressionLevel: [6, 9],
        quality: [80, 85, 70, 55, 40, 35],
      },
      transparent: { format: "png" },
    });
    expect(result).toStrictEqual(
      success(output, "image/jpeg", [
        "[Image: original 1200x3000, displayed at 640x1600. Multiply coordinates by 1.88 to map to original image.]",
      ]),
    );
  });

  it("omits images when Rastermill cannot satisfy the base64 budget", async () => {
    mocks.probe.mockResolvedValue({ height: 4000, orientation: null, width: 4000 });
    mocks.encode.mockResolvedValue({
      ...encoded,
      data: Buffer.alloc(90),
      height: 1,
      resized: true,
      width: 1,
      withinBudget: false,
    });

    await expect(resize(Buffer.from("too large"))).resolves.toStrictEqual({
      ok: false,
      message: "[Image omitted: could not be resized below the inline image size limit.]",
    });
  });

  it("does not add coordinate hints when Rastermill only re-encodes the image", async () => {
    const input = Buffer.alloc(((4.5 * 1024 * 1024) / 4) * 3 + 1);
    await expect(resize(input)).resolves.toStrictEqual(success(output, "image/jpeg"));
  });
});
