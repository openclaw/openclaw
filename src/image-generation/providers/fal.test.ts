import { afterEach, describe, expect, it, vi } from "vitest";
import * as modelAuth from "../../agents/model-auth.js";
import { buildFalImageGenerationProvider } from "./fal.js";
import { createFalFetchMock, mockProviderAuth, expectFalFetchCall, expectFalJsonPost, expectImageResult } from "./test-helpers.js";

describe("fal image-generation provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("generates image buffers from the fal sync API", async () => {
    mockProviderAuth({ provider: "fal", apiKey: "fal-test-key" });
    const fetchMock = createFalFetchMock({
      imageUrl: "https://v3.fal.media/files/example/generated.png",
      contentType: "image/png",
      imageData: "png-data",
      prompt: "draw a cat",
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = buildFalImageGenerationProvider();
    const result = await provider.generateImage({
      provider: "fal",
      model: "fal-ai/flux/dev",
      prompt: "draw a cat",
      cfg: {},
      count: 2,
      size: "1536x1024",
    });

    expectFalFetchCall(fetchMock, {
      call: 1,
      url: "https://fal.run/fal-ai/flux/dev",
      body: {
        prompt: "draw a cat",
        image_size: { width: 1536, height: 1024 },
        num_images: 2,
        output_format: "png",
      },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://v3.fal.media/files/example/generated.png",
    );
    expectImageResult(result, {
      imageData: "png-data",
      mimeType: "image/png",
      model: "fal-ai/flux/dev",
      fileName: "image-1.png",
      metadata: { prompt: "draw a cat" },
    });
  });

  it("uses image-to-image endpoint and data-uri input for edits", async () => {
    mockProviderAuth({ provider: "fal", apiKey: "fal-test-key" });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          images: [{ url: "https://v3.fal.media/files/example/edited.png" }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-type": "image/png" }),
        arrayBuffer: async () => Buffer.from("edited-data"),
      });
    vi.stubGlobal("fetch", fetchMock);

    const provider = buildFalImageGenerationProvider();
    await provider.generateImage({
      provider: "fal",
      model: "fal-ai/flux/dev",
      prompt: "turn this into a noir poster",
      cfg: {},
      resolution: "2K",
      inputImages: [
        {
          buffer: Buffer.from("source-image"),
          mimeType: "image/jpeg",
          fileName: "source.jpg",
        },
      ],
    });

    expectFalFetchCall(fetchMock, {
      call: 1,
      url: "https://fal.run/fal-ai/flux/dev/image-to-image",
      body: {
        prompt: "turn this into a noir poster",
        image_size: { width: 2048, height: 2048 },
        num_images: 1,
        output_format: "png",
        image_url: `data:image/jpeg;base64,${Buffer.from("source-image").toString("base64")}`,
      },
    });
  });

  it("maps aspect ratio for text generation without forcing a square default", async () => {
    vi.spyOn(modelAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "fal-test-key",
      source: "env",
      mode: "api-key",
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          images: [{ url: "https://v3.fal.media/files/example/wide.png" }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-type": "image/png" }),
        arrayBuffer: async () => Buffer.from("wide-data"),
      });
    vi.stubGlobal("fetch", fetchMock);

    const provider = buildFalImageGenerationProvider();
    await provider.generateImage({
      provider: "fal",
      model: "fal-ai/flux/dev",
      prompt: "wide cinematic shot",
      cfg: {},
      aspectRatio: "16:9",
    });

    expectFalFetchCall(fetchMock, {
      call: 1,
      url: "https://fal.run/fal-ai/flux/dev",
      body: {
        prompt: "wide cinematic shot",
        image_size: "landscape_16_9",
        num_images: 1,
        output_format: "png",
      },
      expectedAuth: "Key fal-test-key",
    });
  });

  it("combines resolution and aspect ratio for text generation", async () => {
    vi.spyOn(modelAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "fal-test-key",
      source: "env",
      mode: "api-key",
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          images: [{ url: "https://v3.fal.media/files/example/portrait.png" }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-type": "image/png" }),
        arrayBuffer: async () => Buffer.from("portrait-data"),
      });
    vi.stubGlobal("fetch", fetchMock);

    const provider = buildFalImageGenerationProvider();
    await provider.generateImage({
      provider: "fal",
      model: "fal-ai/flux/dev",
      prompt: "portrait poster",
      cfg: {},
      resolution: "2K",
      aspectRatio: "9:16",
    });

    expectFalFetchCall(fetchMock, {
      call: 1,
      url: "https://fal.run/fal-ai/flux/dev",
      body: {
        prompt: "portrait poster",
        image_size: { width: 1152, height: 2048 },
        num_images: 1,
        output_format: "png",
      },
      expectedAuth: "Key fal-test-key",
    });
  });

  it("rejects multi-image edit requests for now", async () => {
    vi.spyOn(modelAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "fal-test-key",
      source: "env",
      mode: "api-key",
    });

    const provider = buildFalImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "fal",
        model: "fal-ai/flux/dev",
        prompt: "combine these",
        cfg: {},
        inputImages: [
          { buffer: Buffer.from("one"), mimeType: "image/png" },
          { buffer: Buffer.from("two"), mimeType: "image/png" },
        ],
      }),
    ).rejects.toThrow("at most one reference image");
  });

  it("rejects aspect ratio overrides for the current edit endpoint", async () => {
    vi.spyOn(modelAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "fal-test-key",
      source: "env",
      mode: "api-key",
    });

    const provider = buildFalImageGenerationProvider();
    await expect(
      provider.generateImage({
        provider: "fal",
        model: "fal-ai/flux/dev",
        prompt: "make it widescreen",
        cfg: {},
        aspectRatio: "16:9",
        inputImages: [{ buffer: Buffer.from("one"), mimeType: "image/png" }],
      }),
    ).rejects.toThrow("does not support aspectRatio overrides");
  });
});
