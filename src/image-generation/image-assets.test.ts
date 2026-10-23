import { describe, expect, it } from "vitest";
import {
  generatedImageAssetFromDataUrl,
  imageFileExtensionForMimeType,
  imageSourceUploadFileName,
  parseImageDataUrl,
  parseOpenAiCompatibleImageResponse,
  resolveInlineImageJsonResponseMaxBytes,
  resolveImageSourceUrl,
  sniffImageMimeType,
  toImageDataUrl,
} from "./image-assets.js";

const malformedDataUrl = "data:image/png;base64,not-base64!";
const missingImage = "missing image";
const sourceUrl = (image: Parameters<typeof resolveImageSourceUrl>[0]) =>
  resolveImageSourceUrl(image, missingImage);

describe("image asset helpers", () => {
  it("preserves omitted images, URL precedence, and inline image MIME defaults", () => {
    const source = { url: " https://example.com/frame.png ", buffer: Buffer.from("unused") };
    expect(sourceUrl(undefined)).toBeUndefined();
    expect(sourceUrl(source)).toBe("https://example.com/frame.png");
    expect(sourceUrl({ url: " ", buffer: Buffer.from("png") })).toBe("data:image/png;base64,cG5n");
    expect(sourceUrl({ buffer: Buffer.from("jpeg"), mimeType: " image/jpeg " })).toBe(
      "data:image/jpeg;base64,anBlZw==",
    );
    expect(() => sourceUrl({})).toThrow(missingImage);
  });

  it("converts buffers to image data URLs and parses them back", () => {
    const buffer = Buffer.from("png-bytes");
    const base64 = buffer.toString("base64");
    const dataUrl = toImageDataUrl({ buffer, mimeType: "image/png" });
    expect(dataUrl).toBe(`data:image/png;base64,${base64}`);
    expect(parseImageDataUrl(dataUrl)).toEqual({ mimeType: "image/png", base64 });
    const asset = generatedImageAssetFromDataUrl({ dataUrl, index: 1 });
    expect(asset).toEqual({ buffer, mimeType: "image/png", fileName: "image-2.png" });
  });

  it("rejects malformed base64 image data URLs", () => {
    expect(parseImageDataUrl(malformedDataUrl)).toBeUndefined();
    expect(generatedImageAssetFromDataUrl({ dataUrl: malformedDataUrl, index: 0 })).toBeUndefined();
  });

  it("normalizes image file extensions", () => {
    expect(imageFileExtensionForMimeType("image/jpeg")).toBe("jpg");
    expect(imageFileExtensionForMimeType("image/webp")).toBe("webp");
    expect(imageFileExtensionForMimeType("image/svg+xml")).toBe("svg");
    expect(imageFileExtensionForMimeType(undefined, "jpg")).toBe("jpg");
  });

  it("sizes inline image JSON caps from decoded image payload limits", () => {
    const maxBytes = (count: number) =>
      resolveInlineImageJsonResponseMaxBytes(count, 6 * 1024 * 1024);
    expect(maxBytes(4)).toBe(34_603_008);
    expect(maxBytes(Number.NaN)).toBe(9_437_184);
    expect(resolveInlineImageJsonResponseMaxBytes(2, 8 * 1024 * 1024)).toBe(23_418_198);
  });

  it("sniffs generated PNG images", () => {
    expect(sniffImageMimeType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))).toEqual({
      mimeType: "image/png",
      extension: "png",
    });
  });

  it("parses OpenAI-compatible base64 image responses", () => {
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xdb]);
    const payload = {
      data: [
        { b64_json: jpegBytes.toString("base64"), revised_prompt: "revised" },
        { b64_json: "" },
      ],
    };
    const images = parseOpenAiCompatibleImageResponse(payload, {
      defaultMimeType: "image/png",
      sniffMimeType: true,
    });
    expect(images).toEqual([
      {
        buffer: jpegBytes,
        mimeType: "image/jpeg",
        fileName: "image-1.jpg",
        revisedPrompt: "revised",
      },
    ]);
  });

  it("rejects malformed OpenAI-compatible image responses in strict mode", () => {
    const payload = { data: [{ b64_json: "not-base64!" }] };
    const malformedResponseError = "Sample image response malformed";
    expect(() =>
      parseOpenAiCompatibleImageResponse(payload, {
        defaultMimeType: "image/png",
        malformedResponseError,
      }),
    ).toThrow(malformedResponseError);
  });

  it("resolves source upload filenames from explicit names or MIME types", () => {
    const image = { buffer: Buffer.from("x"), mimeType: "image/webp" };
    const namedImage = { ...image, mimeType: "image/png", fileName: "source.png" };
    expect(imageSourceUploadFileName({ image, index: 2 })).toBe("image-3.webp");
    expect(imageSourceUploadFileName({ image: namedImage, index: 0 })).toBe("source.png");
  });
});
