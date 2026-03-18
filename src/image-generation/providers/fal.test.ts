import { afterEach, describe, expect, it, vi } from "vitest";
import * as modelAuth from "../../agents/model-auth.js";
import { buildFalImageGenerationProvider } from "./fal.js";

describe("fal image-generation provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("generates image buffers from the fal sync API", async () => {
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
          images: [
            {
              url: "https://v3.fal.media/files/example/generated.png",
              content_type: "image/png",
            },
          ],
          prompt: "draw a cat",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-type": "image/png" }),
        arrayBuffer: async () => Buffer.from("png-data"),
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

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://fal.run/fal-ai/flux/dev",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          prompt: "draw a cat",
          image_size: { width: 1536, height: 1024 },
          num_images: 2,
          output_format: "png",
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://v3.fal.media/files/example/generated.png",
    );
    expect(result).toEqual({
      images: [
        {
          buffer: Buffer.from("png-data"),
          mimeType: "image/png",
          fileName: "image-1.png",
        },
      ],
      model: "fal-ai/flux/dev",
      metadata: { prompt: "draw a cat" },
    });
  });

  it("uses image-to-image endpoint and data-uri input for edits", async () => {
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

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://fal.run/fal-ai/flux/dev/image-to-image",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          prompt: "turn this into a noir poster",
          image_size: { width: 2048, height: 2048 },
          num_images: 1,
          output_format: "png",
          image_url: `data:image/jpeg;base64,${Buffer.from("source-image").toString("base64")}`,
        }),
      }),
    );
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
});
