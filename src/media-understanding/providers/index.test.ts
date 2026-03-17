import { afterEach, describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "../../plugins/registry.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { buildMediaUnderstandingRegistry, getMediaUnderstandingProvider } from "./index.js";

describe("media-understanding provider registry", () => {
  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("registers the Mistral provider", () => {
    const registry = buildMediaUnderstandingRegistry();
    const provider = getMediaUnderstandingProvider("mistral", registry);

    expect(provider?.id).toBe("mistral");
    expect(provider?.capabilities).toEqual(["audio"]);
  });

  it("keeps provider id normalization behavior", () => {
    const registry = buildMediaUnderstandingRegistry();
    const provider = getMediaUnderstandingProvider("gemini", registry);

    expect(provider?.id).toBe("google");
  });

  it("registers the Moonshot provider", () => {
    const registry = buildMediaUnderstandingRegistry();
    const provider = getMediaUnderstandingProvider("moonshot", registry);

    expect(provider?.id).toBe("moonshot");
    expect(provider?.capabilities).toEqual(["image", "video"]);
  });

  it("registers the minimax portal provider", () => {
    const registry = buildMediaUnderstandingRegistry();
    const provider = getMediaUnderstandingProvider("minimax-portal", registry);

    expect(provider?.id).toBe("minimax-portal");
    expect(provider?.capabilities).toEqual(["image"]);
  });

  it("merges plugin-registered media providers into the active registry", async () => {
    const pluginRegistry = createEmptyPluginRegistry();
    pluginRegistry.mediaUnderstandingProviders.push({
      pluginId: "google",
      pluginName: "Google Plugin",
      source: "test",
      provider: {
        id: "google",
        capabilities: ["image", "audio", "video"],
        describeImage: async () => ({ text: "plugin image" }),
        transcribeAudio: async () => ({ text: "plugin audio" }),
        describeVideo: async () => ({ text: "plugin video" }),
      },
    });
    setActivePluginRegistry(pluginRegistry);

    const registry = buildMediaUnderstandingRegistry();
    const provider = getMediaUnderstandingProvider("gemini", registry);

    expect(provider?.id).toBe("google");
    expect(await provider?.describeVideo?.({} as never)).toEqual({ text: "plugin video" });
  });
});
