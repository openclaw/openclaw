import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { ImageGenerationProvider } from "../image-generation/types.js";
import {
  generateImage,
  listRuntimeImageGenerationProviders,
  type GenerateImageRuntimeResult,
} from "./runtime.js";

const mocks = vi.hoisted(() => ({
  generateImage: vi.fn<typeof generateImage>(),
  listRuntimeImageGenerationProviders: vi.fn<typeof listRuntimeImageGenerationProviders>(),
}));

vi.mock("../../extensions/image-generation-core/runtime-api.js", () => ({
  generateImage: mocks.generateImage,
  listRuntimeImageGenerationProviders: mocks.listRuntimeImageGenerationProviders,
}));

describe("image-generation runtime facade", () => {
  afterEach(() => {
    mocks.generateImage.mockReset();
    mocks.listRuntimeImageGenerationProviders.mockReset();
  });

  it("delegates image generation to the image runtime", async () => {
    const result: GenerateImageRuntimeResult = {
      images: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png", fileName: "sample.png" }],
      provider: "image-plugin",
      model: "img-v1",
      attempts: [],
    };
    mocks.generateImage.mockResolvedValue(result);
    const params = {
      cfg: {
        agents: {
          defaults: {
            imageGenerationModel: { primary: "image-plugin/img-v1" },
          },
        },
      } as OpenClawConfig,
      prompt: "draw a cat",
      agentDir: "/tmp/agent",
      authStore: { version: 1, profiles: {} },
    };

    await expect(generateImage(params)).resolves.toBe(result);
    expect(mocks.generateImage).toHaveBeenCalledWith(params);
  });

  it("delegates provider listing to the image runtime", () => {
    const providers: ImageGenerationProvider[] = [
      {
        id: "image-plugin",
        defaultModel: "img-v1",
        models: ["img-v1", "img-v2"],
        capabilities: {
          generate: {},
          edit: { enabled: false },
        },
        generateImage: async () => ({
          images: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
        }),
      },
    ];
    mocks.listRuntimeImageGenerationProviders.mockReturnValue(providers);
    const params = { config: {} as OpenClawConfig };

    expect(listRuntimeImageGenerationProviders(params)).toBe(providers);
    expect(mocks.listRuntimeImageGenerationProviders).toHaveBeenCalledWith(params);
  });
});
