import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import type { ImageGenerationProviderPlugin } from "../plugins/types.js";
import { getImageGenerationProvider, listImageGenerationProviders } from "./provider-registry.js";

const { resolvePluginCapabilityProvidersMock } = vi.hoisted(() => ({
  resolvePluginCapabilityProvidersMock: vi.fn<() => ImageGenerationProviderPlugin[]>(() => []),
}));

vi.mock("../plugins/capability-provider-runtime.js", () => ({
  resolvePluginCapabilityProviders: resolvePluginCapabilityProvidersMock,
}));

function createProvider(
  params: Pick<ImageGenerationProviderPlugin, "id"> & Partial<ImageGenerationProviderPlugin>,
): ImageGenerationProviderPlugin {
  return {
    label: params.id,
    capabilities: {
      generate: {},
      edit: { enabled: false },
    },
    generateImage: async () => ({
      images: [{ buffer: Buffer.from("image"), mimeType: "image/png" }],
    }),
    ...params,
  };
}

function requireImageProvider(id: string): ImageGenerationProviderPlugin {
  const provider = getImageGenerationProvider(id);
  if (!provider) {
    throw new Error(`expected image generation provider ${id}`);
  }
  return provider;
}

describe("image-generation provider registry", () => {
  beforeEach(() => {
    resolvePluginCapabilityProvidersMock.mockReset();
    resolvePluginCapabilityProvidersMock.mockReturnValue([]);
  });

  it("delegates provider resolution to the capability provider boundary", () => {
    const cfg = {} as OpenClawConfig;

    expect(listImageGenerationProviders(cfg)).toStrictEqual([]);
    expect(resolvePluginCapabilityProvidersMock).toHaveBeenCalledWith({
      key: "imageGenerationProviders",
      cfg,
    });
  });

  it("uses active plugin providers without loading from disk", () => {
    resolvePluginCapabilityProvidersMock.mockReturnValue([createProvider({ id: "custom-image" })]);

    const provider = getImageGenerationProvider("custom-image");

    expect(provider?.id).toBe("custom-image");
    expect(resolvePluginCapabilityProvidersMock).toHaveBeenCalledWith({
      key: "imageGenerationProviders",
      cfg: undefined,
    });
  });

  it("ignores prototype-like provider ids and aliases", () => {
    resolvePluginCapabilityProvidersMock.mockReturnValue([
      createProvider({ id: "__proto__", aliases: ["constructor", "prototype"] }),
      createProvider({ id: "safe-image", aliases: ["safe-alias", "constructor"] }),
    ]);

    expect(listImageGenerationProviders().map((provider) => provider.id)).toEqual(["safe-image"]);
    expect(getImageGenerationProvider("__proto__")).toBeUndefined();
    expect(getImageGenerationProvider("constructor")).toBeUndefined();
    expect(requireImageProvider("safe-alias").id).toBe("safe-image");
  });
});
