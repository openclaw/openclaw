import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as imageGenerationRuntime from "../../image-generation/runtime.js";
import * as imageOps from "../../media/image-ops.js";
import * as mediaStore from "../../media/store.js";
import * as webMedia from "../../plugin-sdk/web-media.js";
import {
  createImageGenerateTool,
  resolveImageGenerationModelConfigForTool,
} from "./image-generate-tool.js";

function stubImageGenerationProviders() {
  vi.spyOn(imageGenerationRuntime, "listRuntimeImageGenerationProviders").mockReturnValue([
    {
      id: "google",
      defaultModel: "gemini-3.1-flash-image-preview",
      models: ["gemini-3.1-flash-image-preview", "gemini-3-pro-image-preview"],
      supportedResolutions: ["1K", "2K", "4K"],
      supportsImageEditing: true,
      generateImage: vi.fn(async () => {
        throw new Error("not used");
      }),
    },
    {
      id: "openai",
      defaultModel: "gpt-image-1",
      models: ["gpt-image-1"],
      supportedSizes: ["1024x1024", "1024x1536", "1536x1024"],
      supportsImageEditing: false,
      generateImage: vi.fn(async () => {
        throw new Error("not used");
      }),
    },
  ]);
}

describe("createImageGenerateTool", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEYS", "");
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("GEMINI_API_KEYS", "");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("returns null when no image-generation model can be inferred", () => {
    stubImageGenerationProviders();
    expect(createImageGenerateTool({ config: {} })).toBeNull();
  });

  it("infers an OpenAI image-generation model from env-backed auth", () => {
    stubImageGenerationProviders();
    vi.stubEnv("OPENAI_API_KEY", "openai-test");

    expect(resolveImageGenerationModelConfigForTool({ cfg: {} })).toEqual({
      primary: "openai/gpt-image-1",
    });
    expect(createImageGenerateTool({ config: {} })).not.toBeNull();
  });

  it("prefers the primary model provider when multiple image providers have auth", () => {
    stubImageGenerationProviders();
    vi.stubEnv("OPENAI_API_KEY", "openai-test");
    vi.stubEnv("GEMINI_API_KEY", "gemini-test");

    expect(
      resolveImageGenerationModelConfigForTool({
        cfg: {
          agents: {
            defaults: {
              model: {
                primary: "google/gemini-3.1-pro-preview",
              },
            },
          },
        },
      }),
    ).toEqual({
      primary: "google/gemini-3.1-flash-image-preview",
      fallbacks: ["openai/gpt-image-1"],
    });
  });

  it("generates images and returns MEDIA paths", async () => {
    const generateImage = vi.spyOn(imageGenerationRuntime, "generateImage").mockResolvedValue({
      provider: "openai",
      model: "gpt-image-1",
      attempts: [],
      images: [
        {
          buffer: Buffer.from("png-1"),
          mimeType: "image/png",
          fileName: "cat-one.png",
        },
        {
          buffer: Buffer.from("png-2"),
          mimeType: "image/png",
          fileName: "cat-two.png",
          revisedPrompt: "A more cinematic cat",
        },
      ],
    });
    const saveMediaBuffer = vi.spyOn(mediaStore, "saveMediaBuffer");
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/generated-1.png",
      id: "generated-1.png",
      size: 5,
      contentType: "image/png",
    });
    saveMediaBuffer.mockResolvedValueOnce({
      path: "/tmp/generated-2.png",
      id: "generated-2.png",
      size: 5,
      contentType: "image/png",
    });

    const tool = createImageGenerateTool({
      config: {
        agents: {
          defaults: {
            imageGenerationModel: {
              primary: "openai/gpt-image-1",
            },
          },
        },
      },
      agentDir: "/tmp/agent",
    });

    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("expected image_generate tool");
    }

    const result = await tool.execute("call-1", {
      prompt: "A cat wearing sunglasses",
      model: "openai/gpt-image-1",
      count: 2,
      size: "1024x1024",
    });

    expect(generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: {
          agents: {
            defaults: {
              imageGenerationModel: {
                primary: "openai/gpt-image-1",
              },
            },
          },
        },
        prompt: "A cat wearing sunglasses",
        agentDir: "/tmp/agent",
        modelOverride: "openai/gpt-image-1",
        size: "1024x1024",
        count: 2,
        inputImages: [],
      }),
    );
    expect(saveMediaBuffer).toHaveBeenNthCalledWith(
      1,
      Buffer.from("png-1"),
      "image/png",
      "tool-image-generation",
      undefined,
      "cat-one.png",
    );
    expect(saveMediaBuffer).toHaveBeenNthCalledWith(
      2,
      Buffer.from("png-2"),
      "image/png",
      "tool-image-generation",
      undefined,
      "cat-two.png",
    );
    expect(result).toMatchObject({
      content: [
        {
          type: "text",
          text: expect.stringContaining("Generated 2 images with openai/gpt-image-1."),
        },
      ],
      details: {
        provider: "openai",
        model: "gpt-image-1",
        count: 2,
        paths: ["/tmp/generated-1.png", "/tmp/generated-2.png"],
        revisedPrompts: ["A more cinematic cat"],
      },
    });
    const text = (result.content?.[0] as { text: string } | undefined)?.text ?? "";
    expect(text).toContain("MEDIA:/tmp/generated-1.png");
    expect(text).toContain("MEDIA:/tmp/generated-2.png");
  });

  it("rejects counts outside the supported range", async () => {
    const tool = createImageGenerateTool({
      config: {
        agents: {
          defaults: {
            imageGenerationModel: {
              primary: "google/gemini-3.1-flash-image-preview",
            },
          },
        },
      },
    });
    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("expected image_generate tool");
    }

    await expect(tool.execute("call-2", { prompt: "too many cats", count: 5 })).rejects.toThrow(
      "count must be between 1 and 4",
    );
  });

  it("forwards reference images and inferred resolution for edit mode", async () => {
    const generateImage = vi.spyOn(imageGenerationRuntime, "generateImage").mockResolvedValue({
      provider: "google",
      model: "gemini-3-pro-image-preview",
      attempts: [],
      images: [
        {
          buffer: Buffer.from("png-out"),
          mimeType: "image/png",
          fileName: "edited.png",
        },
      ],
    });
    vi.spyOn(webMedia, "loadWebMedia").mockResolvedValue({
      kind: "image",
      buffer: Buffer.from("input-image"),
      contentType: "image/png",
    });
    vi.spyOn(imageOps, "getImageMetadata").mockResolvedValue({
      width: 3200,
      height: 1800,
    });
    vi.spyOn(mediaStore, "saveMediaBuffer").mockResolvedValue({
      path: "/tmp/edited.png",
      id: "edited.png",
      size: 7,
      contentType: "image/png",
    });

    const tool = createImageGenerateTool({
      config: {
        agents: {
          defaults: {
            imageGenerationModel: {
              primary: "google/gemini-3-pro-image-preview",
            },
          },
        },
      },
      workspaceDir: process.cwd(),
    });

    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("expected image_generate tool");
    }

    await tool.execute("call-edit", {
      prompt: "Add a dramatic stormy sky but keep everything else identical.",
      image: "./fixtures/reference.png",
    });

    expect(generateImage).toHaveBeenCalledWith(
      expect.objectContaining({
        resolution: "4K",
        inputImages: [
          expect.objectContaining({
            buffer: Buffer.from("input-image"),
            mimeType: "image/png",
          }),
        ],
      }),
    );
  });

  it("lists registered provider and model options", async () => {
    stubImageGenerationProviders();

    const tool = createImageGenerateTool({
      config: {
        agents: {
          defaults: {
            imageGenerationModel: {
              primary: "google/gemini-3.1-flash-image-preview",
            },
          },
        },
      },
    });

    expect(tool).not.toBeNull();
    if (!tool) {
      throw new Error("expected image_generate tool");
    }

    const result = await tool.execute("call-list", { action: "list" });
    const text = (result.content?.[0] as { text: string } | undefined)?.text ?? "";

    expect(text).toContain("google (default gemini-3.1-flash-image-preview)");
    expect(text).toContain("gemini-3.1-flash-image-preview");
    expect(text).toContain("gemini-3-pro-image-preview");
    expect(text).toContain("editing");
    expect(result).toMatchObject({
      details: {
        providers: expect.arrayContaining([
          expect.objectContaining({
            id: "google",
            defaultModel: "gemini-3.1-flash-image-preview",
            models: expect.arrayContaining([
              "gemini-3.1-flash-image-preview",
              "gemini-3-pro-image-preview",
            ]),
          }),
        ]),
      },
    });
  });
});
