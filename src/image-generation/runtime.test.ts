import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { vi } from "vitest";

let generateImage: typeof import("./runtime.js").generateImage;
let listRuntimeImageGenerationProviders: typeof import("./runtime.js").listRuntimeImageGenerationProviders;

describe("image-generation runtime helpers", () => {
  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  beforeEach(async () => {
    vi.resetModules();
    ({ generateImage, listRuntimeImageGenerationProviders } = await import("./runtime.js"));
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
        capabilities: {
          generate: {},
          edit: { enabled: false },
        },
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
        capabilities: {
          generate: {
            supportsResolution: true,
          },
          edit: {
            enabled: true,
            maxInputImages: 3,
          },
          geometry: {
            resolutions: ["1K", "2K"],
          },
        },
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
        capabilities: {
          generate: {
            supportsResolution: true,
          },
          edit: {
            enabled: true,
            maxInputImages: 3,
          },
          geometry: {
            resolutions: ["1K", "2K"],
          },
        },
      },
    ]);
  });

  it("explains native image-generation config and provider auth when no model is configured", async () => {
    const pluginRegistry = createEmptyPluginRegistry();
    pluginRegistry.imageGenerationProviders.push(
      {
        pluginId: "google",
        pluginName: "Google",
        source: "test",
        provider: {
          id: "google",
          defaultModel: "gemini-3-pro-image-preview",
          capabilities: {
            generate: {},
            edit: { enabled: false },
          },
          generateImage: async () => ({
            images: [{ buffer: Buffer.from("x"), mimeType: "image/png" }],
          }),
        },
      },
      {
        pluginId: "openai",
        pluginName: "OpenAI",
        source: "test",
        provider: {
          id: "openai",
          defaultModel: "gpt-image-1",
          capabilities: {
            generate: {},
            edit: { enabled: false },
          },
          generateImage: async () => ({
            images: [{ buffer: Buffer.from("x"), mimeType: "image/png" }],
          }),
        },
      },
    );
    setActivePluginRegistry(pluginRegistry);

    await expect(
      generateImage({ cfg: {} as OpenClawConfig, prompt: "draw a cat" }),
    ).rejects.toThrow(
      'Set agents.defaults.imageGenerationModel.primary to a provider/model like "google/gemini-3-pro-image-preview".',
    );
    await expect(
      generateImage({ cfg: {} as OpenClawConfig, prompt: "draw a cat" }),
    ).rejects.toThrow("google: GEMINI_API_KEY / GOOGLE_API_KEY");
    await expect(
      generateImage({ cfg: {} as OpenClawConfig, prompt: "draw a cat" }),
    ).rejects.toThrow("openai: OPENAI_API_KEY");
  });

  it("does not crash on prototype-like provider ids in auth hints", async () => {
    const pluginRegistry = createEmptyPluginRegistry();
    pluginRegistry.imageGenerationProviders.push({
      pluginId: "proto-provider",
      pluginName: "Proto Provider",
      source: "test",
      provider: {
        id: "__proto__",
        defaultModel: "proto-v1",
        capabilities: {
          generate: {},
          edit: { enabled: false },
        },
        generateImage: async () => ({
          images: [{ buffer: Buffer.from("x"), mimeType: "image/png" }],
        }),
      },
    });
    setActivePluginRegistry(pluginRegistry);

    await expect(
      generateImage({ cfg: {} as OpenClawConfig, prompt: "draw a cat" }),
    ).rejects.toThrow("No image-generation model configured.");
  });
});
