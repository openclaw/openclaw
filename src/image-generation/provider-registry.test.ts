import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry.js";

const { resolveRuntimePluginRegistryMock } = vi.hoisted(() => ({
  resolveRuntimePluginRegistryMock: vi.fn<
    (params?: unknown) => ReturnType<typeof createEmptyPluginRegistry> | undefined
  >(() => undefined),
}));

vi.mock("../plugins/loader.js", () => ({
  resolveRuntimePluginRegistry: resolveRuntimePluginRegistryMock,
}));

let getImageGenerationProvider: typeof import("./provider-registry.js").getImageGenerationProvider;
let listImageGenerationProviders: typeof import("./provider-registry.js").listImageGenerationProviders;

describe("image-generation provider registry", () => {
  beforeAll(async () => {
    ({ getImageGenerationProvider, listImageGenerationProviders } =
      await import("./provider-registry.js"));
  });

  afterEach(() => {
    resolveRuntimePluginRegistryMock.mockReset();
    resolveRuntimePluginRegistryMock.mockReturnValue(undefined);
  });

  it("does not load plugins when listing without config", () => {
    expect(listImageGenerationProviders()).toEqual([]);
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledWith();
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
    resolveRuntimePluginRegistryMock.mockReturnValue(registry);

    const provider = getImageGenerationProvider("custom-image");

    expect(provider?.id).toBe("custom-image");
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledWith();
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
    resolveRuntimePluginRegistryMock.mockReturnValue(registry);

    expect(listImageGenerationProviders().map((provider) => provider.id)).toEqual(["safe-image"]);
    expect(getImageGenerationProvider("__proto__")).toBeUndefined();
    expect(getImageGenerationProvider("constructor")).toBeUndefined();
    expect(getImageGenerationProvider("safe-alias")?.id).toBe("safe-image");
  });
});
