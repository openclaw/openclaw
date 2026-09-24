import { FILE_TYPE_SNIFF_MAX_BYTES } from "@openclaw/media-core/mime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { convertImageToJpegMock, convertImageToPngMock, detectMimeMock } = vi.hoisted(() => ({
  convertImageToJpegMock: vi.fn(),
  convertImageToPngMock: vi.fn(),
  detectMimeMock: vi.fn(),
}));

vi.mock("@openclaw/media-core/mime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/media-core/mime")>()),
  detectMime: detectMimeMock,
}));

vi.mock("./image-ops.js", () => ({
  convertImageToJpeg: convertImageToJpegMock,
  convertImageToPng: convertImageToPngMock,
}));

import { normalizeAnthropicInlineContentBlocks } from "./anthropic-inline-images.js";

describe("normalizeAnthropicInlineContentBlocks", () => {
  beforeEach(() => {
    convertImageToJpegMock.mockReset();
    convertImageToJpegMock.mockResolvedValue(Buffer.from("converted-jpeg"));
    convertImageToPngMock.mockReset();
    convertImageToPngMock.mockResolvedValue(Buffer.from("converted-png"));
    detectMimeMock.mockReset();
  });

  it.each([32, FILE_TYPE_SNIFF_MAX_BYTES + 3])(
    "converts all %i unsupported bytes despite a supported declaration",
    async (size) => {
      detectMimeMock.mockResolvedValue("image/tiff");
      const original = Buffer.alloc(size, 0xa7);
      original.write("tiff-bytes", 0);
      original.write("complete-image-tail", size - 19);
      const tiffData = original.toString("base64");

      await expect(
        normalizeAnthropicInlineContentBlocks([
          { type: "image", data: tiffData, mimeType: "image/jpeg" },
        ]),
      ).resolves.toEqual([
        {
          type: "image",
          data: Buffer.from("converted-jpeg").toString("base64"),
          mimeType: "image/jpeg",
        },
      ]);
      expect(convertImageToJpegMock).toHaveBeenCalledExactlyOnceWith(original);
    },
  );

  it("uses a supported declaration when byte detection is inconclusive", async () => {
    detectMimeMock.mockResolvedValue(undefined);
    const opaqueData = Buffer.from("not-a-recognized-image-header").toString("base64");

    await expect(
      normalizeAnthropicInlineContentBlocks([
        { type: "image", data: opaqueData, mimeType: "image/png" },
      ]),
    ).resolves.toEqual([{ type: "image", data: opaqueData, mimeType: "image/png" }]);
    expect(convertImageToJpegMock).not.toHaveBeenCalled();
  });

  it("rejects oversized image data before MIME detection or decoding", async () => {
    const maxBytes = 10 * 1024 * 1024;
    const encodedLength = Math.ceil(((maxBytes + 1) * 4) / 3);

    await expect(
      normalizeAnthropicInlineContentBlocks([
        { type: "image", data: "QQ==", mimeType: "image/png" },
        { type: "image", data: "A".repeat(encodedLength), mimeType: "image/tiff" },
      ]),
    ).rejects.toThrow("10 MB decoded safety limit");
    expect(detectMimeMock).not.toHaveBeenCalled();
    expect(convertImageToJpegMock).not.toHaveBeenCalled();
  });

  it.each(["ZE==", "ZE", "-_8=", "Q!Q==", "QQ==QQ==", "QQ===", "S", "", " \n\t"])(
    "preserves permissive decoding and output data for %j",
    async (data) => {
      detectMimeMock.mockResolvedValue(undefined);
      await expect(
        normalizeAnthropicInlineContentBlocks([{ type: "image", data, mimeType: "image/png" }]),
      ).resolves.toEqual([{ type: "image", data: data.trim(), mimeType: "image/png" }]);
      expect(detectMimeMock).toHaveBeenCalledExactlyOnceWith({
        buffer: Buffer.from(data.trim(), "base64"),
      });
      expect(convertImageToJpegMock).not.toHaveBeenCalled();
      expect(convertImageToPngMock).not.toHaveBeenCalled();
    },
  );

  it("validates the complete input before choosing a MIME prefix", async () => {
    const original = Buffer.alloc(FILE_TYPE_SNIFF_MAX_BYTES * 2, 0xa7);
    const data = `${original.toString("base64")}!`;
    detectMimeMock.mockResolvedValue(undefined);

    await expect(
      normalizeAnthropicInlineContentBlocks([{ type: "image", data, mimeType: "image/png" }]),
    ).resolves.toEqual([{ type: "image", data, mimeType: "image/png" }]);
    expect(detectMimeMock).toHaveBeenCalledExactlyOnceWith({ buffer: original });
  });

  it("routes detected BMP bytes through the fallback-capable PNG converter", async () => {
    detectMimeMock.mockResolvedValue("image/bmp");
    const bmpData = Buffer.from("bmp-bytes").toString("base64");

    await expect(
      normalizeAnthropicInlineContentBlocks([
        { type: "image", data: bmpData, mimeType: "image/bmp" },
      ]),
    ).resolves.toEqual([
      {
        type: "image",
        data: Buffer.from("converted-png").toString("base64"),
        mimeType: "image/png",
      },
    ]);
    expect(convertImageToPngMock).toHaveBeenCalledOnce();
    expect(convertImageToJpegMock).not.toHaveBeenCalled();
  });

  it("rejects converted images that exceed the outgoing size limit", async () => {
    detectMimeMock.mockResolvedValue("image/tiff");
    convertImageToJpegMock.mockResolvedValue(Buffer.alloc(10 * 1024 * 1024 + 1));

    await expect(
      normalizeAnthropicInlineContentBlocks([
        {
          type: "image",
          data: Buffer.from("small-tiff").toString("base64"),
          mimeType: "image/tiff",
        },
      ]),
    ).rejects.toThrow("Normalized Anthropic inline image exceeds the 10 MB decoded safety limit");
  });
});
