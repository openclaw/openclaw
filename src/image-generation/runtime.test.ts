import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { generateImage, listRuntimeImageGenerationProviders } from "./runtime.js";

describe("image-generation runtime helpers", () => {
  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("generates images through the active image-generation registry", async () => {
    const pluginRegistry = createEmptyPluginRegistry();
    const authStore = { version: 1, profiles: {} } as const;
    let seenAuthStore: unknown;
    pluginRegistry.imageGenerationProviders.push({
      pluginId: "image-plugin",
      pluginName: "Image Plugin",
      source: "test",
      provider: {
        id: "image-plugin",
        async generateImage(req) {
          seenAuthStore = req.authStore;
          return {
            images: [
              {
                buffer: Buffer.from("png-bytes"),
                mimeType: "image/png",
                fileName: "sample.png",
              },
            ],
            model: "img-v1",
          };
        },
      },
    });
    setActivePluginRegistry(pluginRegistry);

    const cfg = {
      agents: {
        defaults: {
          imageGenerationModel: {
            primary: "image-plugin/img-v1",
          },
        },
      },
    } as OpenClawConfig;

    const result = await generateImage({
      cfg,
      prompt: "draw a cat",
      agentDir: "/tmp/agent",
      authStore,
    });

    expect(result.provider).toBe("image-plugin");
    expect(result.model).toBe("img-v1");
    expect(result.attempts).toEqual([]);
    expect(seenAuthStore).toEqual(authStore);
    expect(result.images).toEqual([
      {
        buffer: Buffer.from("png-bytes"),
        mimeType: "image/png",
        fileName: "sample.png",
      },
    ]);
  });

  it("lists runtime image-generation providers from the active registry", () => {
    const pluginRegistry = createEmptyPluginRegistry();
    pluginRegistry.imageGenerationProviders.push({
      pluginId: "image-plugin",
      pluginName: "Image Plugin",
      source: "test",
      provider: {
        id: "image-plugin",
        defaultModel: "img-v1",
        models: ["img-v1", "img-v2"],
        supportedResolutions: ["1K", "2K"],
        generateImage: async () => ({
          images: [{ buffer: Buffer.from("x"), mimeType: "image/png" }],
        }),
      },
    });
    setActivePluginRegistry(pluginRegistry);

    expect(listRuntimeImageGenerationProviders()).toMatchObject([
      {
        id: "image-plugin",
        defaultModel: "img-v1",
        models: ["img-v1", "img-v2"],
        supportedResolutions: ["1K", "2K"],
      },
    ]);
  });
});
