import { afterEach, describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { buildMediaUnderstandingRegistry, getMediaUnderstandingProvider } from "./provider-registry.js";

describe("media-understanding provider registry", () => {
  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("keeps core-owned fallback providers registered by default", () => {
    const registry = buildMediaUnderstandingRegistry();
    const groqProvider = getMediaUnderstandingProvider("groq", registry);
    const deepgramProvider = getMediaUnderstandingProvider("deepgram", registry);

    expect(groqProvider?.id).toBe("groq");
    expect(groqProvider?.capabilities).toEqual(["audio"]);
    expect(deepgramProvider?.id).toBe("deepgram");
    expect(deepgramProvider?.capabilities).toEqual(["audio"]);
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

  it("keeps provider id normalization behavior for plugin-owned providers", () => {
    const pluginRegistry = createEmptyPluginRegistry();
    pluginRegistry.mediaUnderstandingProviders.push({
      pluginId: "google",
      pluginName: "Google Plugin",
      source: "test",
      provider: {
        id: "google",
        capabilities: ["image", "audio", "video"],
      },
    });
    setActivePluginRegistry(pluginRegistry);

    const registry = buildMediaUnderstandingRegistry();
    const provider = getMediaUnderstandingProvider("gemini", registry);

    expect(provider?.id).toBe("google");
  });
});
