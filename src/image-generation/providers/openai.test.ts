import { afterEach, describe, expect, it, vi } from "vitest";
import * as modelAuth from "../../agents/model-auth.js";
import { buildOpenAIImageGenerationProvider } from "./openai.js";

describe("OpenAI image-generation provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("generates PNG buffers from the OpenAI Images API", async () => {
    const resolveApiKeySpy = vi.spyOn(modelAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "sk-test",
      source: "env",
      mode: "api-key",
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            b64_json: Buffer.from("png-data").toString("base64"),
            revised_prompt: "revised",
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = buildOpenAIImageGenerationProvider();
    const authStore = { version: 1, profiles: {} };
    const result = await provider.generateImage({
      provider: "openai",
      model: "gpt-image-1",
      prompt: "draw a cat",
      cfg: {},
      authStore,
    });

    expect(resolveApiKeySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        store: authStore,
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/images/generations",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          model: "gpt-image-1",
          prompt: "draw a cat",
          n: 1,
          size: "1024x1024",
        }),
      }),
    );
    expect(result).toEqual({
      images: [
        {
          buffer: Buffer.from("png-data"),
          mimeType: "image/png",
          fileName: "image-1.png",
          revisedPrompt: "revised",
        },
      ],
      model: "gpt-image-1",
    });
  });

  it("maps supported aspect ratios onto OpenAI size presets", async () => {
    vi.spyOn(modelAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "sk-test",
      source: "env",
      mode: "api-key",
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ b64_json: Buffer.from("png-data").toString("base64") }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = buildOpenAIImageGenerationProvider();
    await provider.generateImage({
      provider: "openai",
      model: "gpt-image-1.5",
      prompt: "draw a portrait",
      aspectRatio: "9:16",
      cfg: {},
      authStore: { version: 1, profiles: {} },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/images/generations",
      expect.objectContaining({
        body: JSON.stringify({
          model: "gpt-image-1.5",
          prompt: "draw a portrait",
          n: 1,
          size: "1024x1536",
        }),
      }),
    );
  });

  it("prefers an explicit size over aspect ratio mapping", async () => {
    vi.spyOn(modelAuth, "resolveApiKeyForProvider").mockResolvedValue({
      apiKey: "sk-test",
      source: "env",
      mode: "api-key",
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ b64_json: Buffer.from("png-data").toString("base64") }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = buildOpenAIImageGenerationProvider();
    await provider.generateImage({
      provider: "openai",
      model: "gpt-image-1.5",
      prompt: "draw a landscape",
      size: "1024x1024",
      aspectRatio: "16:9",
      cfg: {},
      authStore: { version: 1, profiles: {} },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/images/generations",
      expect.objectContaining({
        body: JSON.stringify({
          model: "gpt-image-1.5",
          prompt: "draw a landscape",
          n: 1,
          size: "1024x1024",
        }),
      }),
    );
  });

  it("rejects reference-image edits for now", async () => {
    const provider = buildOpenAIImageGenerationProvider();

    await expect(
      provider.generateImage({
        provider: "openai",
        model: "gpt-image-1",
        prompt: "Edit this image",
        cfg: {},
        inputImages: [{ buffer: Buffer.from("x"), mimeType: "image/png" }],
      }),
    ).rejects.toThrow("does not support reference-image edits");
  });
});
