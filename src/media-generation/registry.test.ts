/** Tests media-generation provider registry aliases and plugin capability integration. */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import type {
  ImageGenerationProviderPlugin,
  VideoGenerationProviderPlugin,
} from "../plugins/types.js";

type ProviderRegistryModule = typeof import("./registry.js");
type GenerationProviderPlugin = ImageGenerationProviderPlugin | VideoGenerationProviderPlugin;

const resolvePluginCapabilityProvidersMock = vi.hoisted(() =>
  vi.fn<() => GenerationProviderPlugin[]>(() => []),
);
vi.mock("../plugins/capability-provider-runtime.js", () => ({
  resolvePluginCapabilityProviders: resolvePluginCapabilityProvidersMock,
}));

function createImageProvider(
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

let registry: ProviderRegistryModule;

beforeAll(async () => {
  vi.resetModules();
  registry = await import("./registry.js");
});

beforeEach(() => {
  resolvePluginCapabilityProvidersMock.mockReset();
  resolvePluginCapabilityProvidersMock.mockReturnValue([]);
});

describe("image-generation provider registry", () => {
  it("ignores prototype-like provider ids and aliases", () => {
    const cfg: OpenClawConfig = {};
    resolvePluginCapabilityProvidersMock.mockReturnValue([
      createImageProvider({ id: "__proto__", aliases: ["constructor", "prototype"] }),
      createImageProvider({ id: "safe-image", aliases: ["safe-alias", "constructor"] }),
    ]);

    expect(registry.listImageGenerationProviders(cfg).map((provider) => provider.id)).toEqual([
      "safe-image",
    ]);
    expect(resolvePluginCapabilityProvidersMock).toHaveBeenCalledWith({
      key: "imageGenerationProviders",
      cfg,
    });
    expect(registry.getImageGenerationProvider("__proto__")).toBeUndefined();
    expect(registry.getImageGenerationProvider("constructor")).toBeUndefined();
    expect(registry.getImageGenerationProvider("safe-alias")?.id).toBe("safe-image");
  });
});

describe("video-generation provider registry", () => {
  it("resolves active providers through the capability boundary", () => {
    resolvePluginCapabilityProvidersMock.mockReturnValue([
      {
        id: "custom-video",
        label: "custom-video",
        capabilities: {},
        generateVideo: async () => ({
          videos: [{ buffer: Buffer.from("video"), mimeType: "video/mp4" }],
        }),
      },
    ]);
    const { getVideoGenerationProvider } = registry;

    const provider = getVideoGenerationProvider("custom-video");

    expect(provider?.id).toBe("custom-video");
    expect(resolvePluginCapabilityProvidersMock).toHaveBeenCalledWith({
      key: "videoGenerationProviders",
      cfg: undefined,
    });
  });
});
