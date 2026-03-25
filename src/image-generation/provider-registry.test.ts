import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";

const { loadOpenClawPluginsMock } = vi.hoisted(() => ({
  loadOpenClawPluginsMock: vi.fn(() => createEmptyPluginRegistry()),
}));

vi.mock("../plugins/loader.js", () => ({
  loadOpenClawPlugins: loadOpenClawPluginsMock,
}));

let getImageGenerationProvider: typeof import("./provider-registry.js").getImageGenerationProvider;
let listImageGenerationProviders: typeof import("./provider-registry.js").listImageGenerationProviders;

describe("image-generation provider registry", () => {
  afterEach(() => {
    loadOpenClawPluginsMock.mockReset();
    loadOpenClawPluginsMock.mockReturnValue(createEmptyPluginRegistry());
    resetPluginRuntimeStateForTest();
  });

  beforeEach(async () => {
    vi.resetModules();
    ({ getImageGenerationProvider, listImageGenerationProviders } =
      await import("./provider-registry.js"));
  });

  it("does not load plugins when listing without config", () => {
    expect(listImageGenerationProviders()).toEqual([]);
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("uses active plugin providers without loading from disk", () => {
    const registry = createEmptyPluginRegistry();
    registry.imageGenerationProviders.push({
      pluginId: "custom-image",
      pluginName: "Custom Image",
      source: "test",
      provider: {
        id: "custom-image",
        label: "Custom Image",
        capabilities: {
          generate: {},
          edit: { enabled: false },
        },
        generateImage: async () => ({
          images: [{ buffer: Buffer.from("image"), mimeType: "image/png" }],
        }),
      },
    });
    setActivePluginRegistry(registry);

    const provider = getImageGenerationProvider("custom-image");

    expect(provider?.id).toBe("custom-image");
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("resolves custom provider to compatible registered image generation provider via api field", () => {
    const registry = createEmptyPluginRegistry();
    registry.imageGenerationProviders.push({
      pluginId: "google",
      pluginName: "Google",
      source: "test",
      provider: {
        id: "google",
        label: "Google",
        capabilities: {
          generate: {},
          edit: { enabled: false },
        },
        generateImage: async () => ({
          images: [{ buffer: Buffer.from("image"), mimeType: "image/png" }],
        }),
      },
    });
    setActivePluginRegistry(registry);

    const cfg = {
      models: {
        providers: {
          "my-gemini-proxy": {
            baseUrl: "https://proxy.example.com/v1beta",
            apiKey: "sk-test",
            api: "google-generative-ai",
            models: [{ id: "gemini-3.1-flash-image-preview" }],
          },
        },
      },
    };

    const provider = getImageGenerationProvider(
      "my-gemini-proxy",
      cfg as unknown as import("../config/config.js").OpenClawConfig,
    );
    expect(provider?.id).toBe("google");
  });

  it("returns undefined for custom provider with unsupported api", () => {
    const registry = createEmptyPluginRegistry();
    setActivePluginRegistry(registry);

    const cfg = {
      models: {
        providers: {
          "custom-llm": {
            baseUrl: "https://example.com",
            api: "anthropic-messages",
            models: [{ id: "auto" }],
          },
        },
      },
    };

    expect(
      getImageGenerationProvider(
        "custom-llm",
        cfg as unknown as import("../config/config.js").OpenClawConfig,
      ),
    ).toBeUndefined();
  });

  it("ignores prototype-like provider ids and aliases", () => {
    const registry = createEmptyPluginRegistry();
    registry.imageGenerationProviders.push(
      {
        pluginId: "blocked-image",
        pluginName: "Blocked Image",
        source: "test",
        provider: {
          id: "__proto__",
          aliases: ["constructor", "prototype"],
          capabilities: {
            generate: {},
            edit: { enabled: false },
          },
          generateImage: async () => ({
            images: [{ buffer: Buffer.from("image"), mimeType: "image/png" }],
          }),
        },
      },
      {
        pluginId: "safe-image",
        pluginName: "Safe Image",
        source: "test",
        provider: {
          id: "safe-image",
          aliases: ["safe-alias", "constructor"],
          capabilities: {
            generate: {},
            edit: { enabled: false },
          },
          generateImage: async () => ({
            images: [{ buffer: Buffer.from("image"), mimeType: "image/png" }],
          }),
        },
      },
    );
    setActivePluginRegistry(registry);

    expect(listImageGenerationProviders().map((provider) => provider.id)).toEqual(["safe-image"]);
    expect(getImageGenerationProvider("__proto__")).toBeUndefined();
    expect(getImageGenerationProvider("constructor")).toBeUndefined();
    expect(getImageGenerationProvider("safe-alias")?.id).toBe("safe-image");
  });
});
