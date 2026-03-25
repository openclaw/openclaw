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
