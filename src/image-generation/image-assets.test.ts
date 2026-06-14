import { describe, expect, it, vi } from "vitest";
import {
  generatedImageAssetFromDataUrl,
  imageFileExtensionForMimeType,
  imageSourceUploadFileName,
  parseImageDataUrl,
  parseOpenAiCompatibleImageResponse,
  parseOpenAiCompatibleImageResponseAsync,
  sniffImageMimeType,
  toImageDataUrl,
} from "./image-assets.js";

describe("image asset helpers", () => {
  it("converts buffers to image data URLs and parses them back", () => {
    const buffer = Buffer.from("png-bytes");
    const dataUrl = toImageDataUrl({ buffer, mimeType: "image/png" });

    expect(dataUrl).toBe(`data:image/png;base64,${buffer.toString("base64")}`);
    expect(parseImageDataUrl(dataUrl)).toEqual({
      mimeType: "image/png",
      base64: buffer.toString("base64"),
    });
    const asset = generatedImageAssetFromDataUrl({ dataUrl, index: 1 });
    if (!asset) {
      throw new Error("Expected generated image asset");
    }
    expect(asset.buffer).toEqual(buffer);
    expect(asset.mimeType).toBe("image/png");
    expect(asset.fileName).toBe("image-2.png");
  });

  it("rejects malformed base64 image data URLs", () => {
    expect(parseImageDataUrl("data:image/png;base64,not-base64!")).toBeUndefined();
    expect(
      generatedImageAssetFromDataUrl({
        dataUrl: "data:image/png;base64,not-base64!",
        index: 0,
      }),
    ).toBeUndefined();
  });

  it("normalizes image file extensions", () => {
    expect(imageFileExtensionForMimeType("image/jpeg")).toBe("jpg");
    expect(imageFileExtensionForMimeType("image/webp")).toBe("webp");
    expect(imageFileExtensionForMimeType("image/svg+xml")).toBe("svg");
    expect(imageFileExtensionForMimeType(undefined, "jpg")).toBe("jpg");
  });

  it("sniffs common generated image types", () => {
    expect(sniffImageMimeType(Buffer.from([0xff, 0xd8, 0xff]))).toEqual({
      mimeType: "image/jpeg",
      extension: "jpg",
    });
    expect(sniffImageMimeType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))).toEqual({
      mimeType: "image/png",
      extension: "png",
    });
  });

  it("parses OpenAI-compatible base64 image responses", () => {
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xdb]);
    const images = parseOpenAiCompatibleImageResponse(
      {
        data: [
          {
            b64_json: jpegBytes.toString("base64"),
            revised_prompt: "revised",
          },
          { b64_json: "" },
        ],
      },
      { defaultMimeType: "image/png", sniffMimeType: true },
    );

    expect(images).toEqual([
      {
        buffer: jpegBytes,
        mimeType: "image/jpeg",
        fileName: "image-1.jpg",
        revisedPrompt: "revised",
      },
    ]);
  });

  it("skips malformed OpenAI-compatible base64 image responses", () => {
    expect(
      parseOpenAiCompatibleImageResponse(
        {
          data: [{ b64_json: "not-base64!" }],
        },
        { defaultMimeType: "image/png" },
      ),
    ).toEqual([]);
  });

  it("rejects malformed OpenAI-compatible image responses in strict mode", () => {
    expect(() =>
      parseOpenAiCompatibleImageResponse(
        {
          data: [{ b64_json: "not-base64!" }],
        },
        {
          defaultMimeType: "image/png",
          malformedResponseError: "Sample image response malformed",
        },
      ),
    ).toThrow("Sample image response malformed");
    expect(() =>
      parseOpenAiCompatibleImageResponse(
        { data: { b64_json: Buffer.from("png").toString("base64") } },
        { malformedResponseError: "Sample image response malformed" },
      ),
    ).toThrow("Sample image response malformed");
  });

  it("parses OpenAI-compatible URL image responses", async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]);
    const downloadUrl = vi.fn(async () => ({
      buffer: pngBytes,
      mimeType: "image/png",
    }));

    const images = await parseOpenAiCompatibleImageResponseAsync(
      {
        data: [
          {
            url: "https://example.test/generated.png",
            revised_prompt: "revised url",
          },
        ],
      },
      { downloadUrl, sniffMimeType: true },
    );

    expect(downloadUrl).toHaveBeenCalledWith({
      url: "https://example.test/generated.png",
      entry: {
        url: "https://example.test/generated.png",
        revised_prompt: "revised url",
      },
      index: 0,
    });
    expect(images).toEqual([
      {
        buffer: pngBytes,
        mimeType: "image/png",
        fileName: "image-1.png",
        revisedPrompt: "revised url",
      },
    ]);
  });

  it("prefers OpenAI-compatible base64 image data over URL fallbacks", async () => {
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xdb]);
    const downloadUrl = vi.fn();

    const images = await parseOpenAiCompatibleImageResponseAsync(
      {
        data: [
          {
            b64_json: jpegBytes.toString("base64"),
            url: "https://example.test/ignored.png",
          },
        ],
      },
      { downloadUrl, sniffMimeType: true },
    );

    expect(downloadUrl).not.toHaveBeenCalled();
    expect(images[0]?.mimeType).toBe("image/jpeg");
    expect(images[0]?.buffer).toEqual(jpegBytes);
  });

  it("rejects OpenAI-compatible URL image responses that are not images", async () => {
    await expect(
      parseOpenAiCompatibleImageResponseAsync(
        { data: [{ url: "https://example.test/not-image" }] },
        {
          downloadUrl: async () => ({
            buffer: Buffer.from("<html></html>"),
            mimeType: "text/html",
          }),
        },
      ),
    ).rejects.toThrow("OpenAI-compatible image URL download did not return an image");
  });

  it("resolves source upload filenames from explicit names or MIME types", () => {
    expect(
      imageSourceUploadFileName({
        image: { buffer: Buffer.from("x"), mimeType: "image/webp" },
        index: 2,
      }),
    ).toBe("image-3.webp");
    expect(
      imageSourceUploadFileName({
        image: { buffer: Buffer.from("x"), mimeType: "image/png", fileName: "source.png" },
        index: 0,
      }),
    ).toBe("source.png");
  });
});
