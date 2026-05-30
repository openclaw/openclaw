import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchWithTimeoutGuardedMock = vi.hoisted(() => vi.fn());

vi.mock("../media-understanding/shared.js", async () => {
  const actual = await vi.importActual<typeof import("../media-understanding/shared.js")>(
    "../media-understanding/shared.js",
  );
  return {
    ...actual,
    fetchWithTimeoutGuarded: fetchWithTimeoutGuardedMock,
  };
});

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
  beforeEach(() => {
    fetchWithTimeoutGuardedMock.mockReset();
  });

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

  it("parses OpenAI-compatible URL image responses through guarded provider HTTP", async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]);
    const release = vi.fn(async () => {});
    const fetchMock = vi.fn();
    fetchWithTimeoutGuardedMock.mockResolvedValueOnce({
      response: new Response(pngBytes, {
        headers: { "content-type": "image/png" },
      }),
      release,
    });

    const images = await parseOpenAiCompatibleImageResponseAsync(
      {
        data: [
          {
            url: "https://example.test/generated.png",
            revised_prompt: "revised url",
          },
        ],
      },
      {
        fetchFn: fetchMock,
        sniffMimeType: true,
        timeoutMs: 12_345,
        ssrfPolicy: { allowedHostnames: ["example.test"] },
        dispatcherPolicy: { mode: "direct" },
      },
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(fetchWithTimeoutGuardedMock).toHaveBeenCalledWith(
      "https://example.test/generated.png",
      {},
      12_345,
      fetchMock,
      {
        ssrfPolicy: { allowedHostnames: ["example.test"] },
        dispatcherPolicy: { mode: "direct" },
        auditContext: "image-generation.openai-compatible.url-download",
      },
    );
    expect(release).toHaveBeenCalledOnce();
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
    const images = await parseOpenAiCompatibleImageResponseAsync(
      {
        data: [
          {
            b64_json: jpegBytes.toString("base64"),
            url: "https://example.test/ignored.png",
          },
        ],
      },
      { sniffMimeType: true },
    );

    expect(fetchWithTimeoutGuardedMock).not.toHaveBeenCalled();
    expect(images[0]?.mimeType).toBe("image/jpeg");
    expect(images[0]?.buffer).toEqual(jpegBytes);
  });

  it("does not forward trusted-origin transport settings to off-origin image URLs", async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]);
    fetchWithTimeoutGuardedMock.mockResolvedValueOnce({
      response: new Response(pngBytes, {
        headers: { "content-type": "image/png" },
      }),
      release: vi.fn(async () => {}),
    });

    await parseOpenAiCompatibleImageResponseAsync(
      {
        data: [{ url: "https://cdn.example.test/generated.png" }],
      },
      {
        trustedOrigin: "https://provider.example.test/v1",
        trustedOriginHeaders: { Authorization: "Bearer secret" },
        trustedOriginDispatcherPolicy: { mode: "direct" },
      },
    );

    expect(fetchWithTimeoutGuardedMock).toHaveBeenCalledWith(
      "https://cdn.example.test/generated.png",
      {},
      undefined,
      fetch,
      {
        auditContext: "image-generation.openai-compatible.url-download",
      },
    );
  });

  it("releases guarded image URL downloads after response failures", async () => {
    const release = vi.fn(async () => {});
    fetchWithTimeoutGuardedMock.mockResolvedValueOnce({
      response: new Response("missing", { status: 404 }),
      release,
    });

    await expect(
      parseOpenAiCompatibleImageResponseAsync({
        data: [{ url: "https://example.test/missing.png" }],
      }),
    ).rejects.toThrow("OpenAI-compatible image URL download failed (404)");
    expect(release).toHaveBeenCalledOnce();
  });

  it("caps OpenAI-compatible URL image response bodies", async () => {
    const release = vi.fn(async () => {});
    fetchWithTimeoutGuardedMock.mockResolvedValueOnce({
      response: new Response("too-large"),
      release,
    });

    await expect(
      parseOpenAiCompatibleImageResponseAsync(
        {
          data: [{ url: "https://example.test/large.png" }],
        },
        { maxBytes: 4 },
      ),
    ).rejects.toThrow("OpenAI-compatible image URL download exceeded maxBytes 4");
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects empty and non-image OpenAI-compatible URL downloads", async () => {
    const emptyRelease = vi.fn(async () => {});
    const htmlRelease = vi.fn(async () => {});
    fetchWithTimeoutGuardedMock
      .mockResolvedValueOnce({
        response: new Response(Buffer.alloc(0), { headers: { "content-type": "image/png" } }),
        release: emptyRelease,
      })
      .mockResolvedValueOnce({
        response: new Response("<html>no image</html>", {
          headers: { "content-type": "text/html" },
        }),
        release: htmlRelease,
      });

    await expect(
      parseOpenAiCompatibleImageResponseAsync({
        data: [{ url: "https://example.test/empty.png" }],
      }),
    ).rejects.toThrow("OpenAI-compatible image URL download returned an empty image");
    await expect(
      parseOpenAiCompatibleImageResponseAsync({
        data: [{ url: "https://example.test/not-image.png" }],
      }),
    ).rejects.toThrow("OpenAI-compatible image URL download did not return an image");
    expect(emptyRelease).toHaveBeenCalledOnce();
    expect(htmlRelease).toHaveBeenCalledOnce();
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
