import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";

const { loadOpenClawPluginsMock } = vi.hoisted(() => ({
  loadOpenClawPluginsMock: vi.fn(() => createEmptyPluginRegistry()),
}));

vi.mock("../plugins/loader.js", () => ({
  loadOpenClawPlugins: loadOpenClawPluginsMock,
}));

import { getImageGenerationProvider, listImageGenerationProviders } from "./provider-registry.js";

describe("image-generation provider registry", () => {
  afterEach(() => {
    loadOpenClawPluginsMock.mockReset();
    loadOpenClawPluginsMock.mockReturnValue(createEmptyPluginRegistry());
    resetPluginRuntimeStateForTest();
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
});
