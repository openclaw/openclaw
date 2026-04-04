import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry.js";

const { resolveRuntimePluginRegistryMock } = vi.hoisted(() => ({
  resolveRuntimePluginRegistryMock: vi.fn<
    (params?: unknown) => ReturnType<typeof createEmptyPluginRegistry> | undefined
  >(() => undefined),
}));

vi.mock("../plugins/loader.js", () => ({
  resolveRuntimePluginRegistry: resolveRuntimePluginRegistryMock,
}));

let getVideoGenerationProvider: typeof import("./provider-registry.js").getVideoGenerationProvider;
let listVideoGenerationProviders: typeof import("./provider-registry.js").listVideoGenerationProviders;

describe("video-generation provider registry", () => {
  beforeAll(async () => {
    ({ getVideoGenerationProvider, listVideoGenerationProviders } =
      await import("./provider-registry.js"));
  });

  beforeEach(() => {
    resolveRuntimePluginRegistryMock.mockReset();
    resolveRuntimePluginRegistryMock.mockReturnValue(undefined);
  });

  it("does not load plugins when listing without config", () => {
    expect(listVideoGenerationProviders()).toEqual([]);
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledWith();
  });

  it("uses active plugin providers without loading from disk", () => {
    const registry = createEmptyPluginRegistry();
    registry.videoGenerationProviders.push({
      pluginId: "custom-video",
      pluginName: "Custom Video",
      source: "test",
      provider: {
        id: "custom-video",
        label: "Custom Video",
        capabilities: {},
        generateVideo: async () => ({
          videos: [{ buffer: Buffer.from("video"), mimeType: "video/mp4" }],
        }),
      },
    });
    resolveRuntimePluginRegistryMock.mockReturnValue(registry);

    const provider = getVideoGenerationProvider("custom-video");

    expect(provider?.id).toBe("custom-video");
    expect(resolveRuntimePluginRegistryMock).toHaveBeenCalledWith();
  });

  it("ignores prototype-like provider ids and aliases", () => {
    const registry = createEmptyPluginRegistry();
    registry.videoGenerationProviders.push(
      {
        pluginId: "blocked-video",
        pluginName: "Blocked Video",
        source: "test",
        provider: {
          id: "__proto__",
          aliases: ["constructor", "prototype"],
          capabilities: {},
          generateVideo: async () => ({
            videos: [{ buffer: Buffer.from("video"), mimeType: "video/mp4" }],
          }),
        },
      },
      {
        pluginId: "safe-video",
        pluginName: "Safe Video",
        source: "test",
        provider: {
          id: "safe-video",
          aliases: ["safe-alias", "constructor"],
          capabilities: {},
          generateVideo: async () => ({
            videos: [{ buffer: Buffer.from("video"), mimeType: "video/mp4" }],
          }),
        },
      },
    );
    resolveRuntimePluginRegistryMock.mockReturnValue(registry);

    expect(listVideoGenerationProviders().map((provider) => provider.id)).toEqual(["safe-video"]);
    expect(getVideoGenerationProvider("__proto__")).toBeUndefined();
    expect(getVideoGenerationProvider("constructor")).toBeUndefined();
    expect(getVideoGenerationProvider("safe-alias")?.id).toBe("safe-video");
  });
});
