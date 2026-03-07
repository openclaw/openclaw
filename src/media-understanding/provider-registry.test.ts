import { afterEach, describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import {
  buildMediaUnderstandingRegistry,
  getMediaUnderstandingProvider,
  normalizeMediaProviderId,
} from "./provider-registry.js";

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

  it("allows lookups regardless of original casing", () => {
    const pluginRegistry = createEmptyPluginRegistry();
    pluginRegistry.mediaUnderstandingProviders.push({
      pluginId: "test-plugin",
      pluginName: "Test Plugin",
      source: "test",
      provider: {
        id: "testprovider",
        capabilities: ["audio"],
        transcribeAudio: async () => ({ text: "transcribed" }),
      },
    });
    setActivePluginRegistry(pluginRegistry);

    const registry = buildMediaUnderstandingRegistry();

    expect(getMediaUnderstandingProvider("testprovider", registry)).toBeDefined();
    expect(getMediaUnderstandingProvider("TESTPROVIDER", registry)).toBeDefined();
    expect(getMediaUnderstandingProvider("TestProvider", registry)).toBeDefined();
    expect(getMediaUnderstandingProvider("testprovider", registry)).toBe(
      getMediaUnderstandingProvider("TESTPROVIDER", registry),
    );
  });

  it("normalizes z.ai alias consistently in lookups", () => {
    const pluginRegistry = createEmptyPluginRegistry();
    pluginRegistry.mediaUnderstandingProviders.push({
      pluginId: "zai-plugin",
      pluginName: "ZAI Plugin",
      source: "test",
      provider: {
        id: "zai",
        capabilities: ["audio"],
        transcribeAudio: async () => ({ text: "zai audio" }),
      },
    });
    setActivePluginRegistry(pluginRegistry);

    const registry = buildMediaUnderstandingRegistry();

    expect(getMediaUnderstandingProvider("z.ai", registry)?.id).toBe("zai");
    expect(getMediaUnderstandingProvider("Z.AI", registry)?.id).toBe("zai");
    expect(getMediaUnderstandingProvider("z-ai", registry)?.id).toBe("zai");
  });
});

describe("capability type guard", () => {
  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("handles providers with undefined routingCapabilities", () => {
    const pluginRegistry = createEmptyPluginRegistry();
    pluginRegistry.providers.push({
      pluginId: "test-plugin",
      pluginName: "Test Plugin",
      source: "test",
      provider: {
        id: "test-provider",
        label: "Test Provider",
        auth: [],
        routingCapabilities: undefined,
        transcribeAudio: async () => ({ text: "transcribed" }),
      },
    });
    setActivePluginRegistry(pluginRegistry);

    expect(() => buildMediaUnderstandingRegistry()).not.toThrow();
  });

  it("handles providers with null routingCapabilities", () => {
    const pluginRegistry = createEmptyPluginRegistry();
    pluginRegistry.providers.push({
      pluginId: "test-plugin",
      pluginName: "Test Plugin",
      source: "test",
      provider: {
        id: "test-provider",
        label: "Test Provider",
        auth: [],
        routingCapabilities: null,
        transcribeAudio: async () => ({ text: "transcribed" }),
      },
    } as never);
    setActivePluginRegistry(pluginRegistry);

    expect(() => buildMediaUnderstandingRegistry()).not.toThrow();
  });

  it("handles providers with object-shaped routingCapabilities", () => {
    const pluginRegistry = createEmptyPluginRegistry();
    pluginRegistry.providers.push({
      pluginId: "test-plugin",
      pluginName: "Test Plugin",
      source: "test",
      provider: {
        id: "test-provider",
        label: "Test Provider",
        auth: [],
        routingCapabilities: { providerFamily: "openai" },
        transcribeAudio: async () => ({ text: "transcribed" }),
      },
    } as never);
    setActivePluginRegistry(pluginRegistry);

    expect(() => buildMediaUnderstandingRegistry()).not.toThrow();
  });

  it("skips providers with non-media capabilities", () => {
    const pluginRegistry = createEmptyPluginRegistry();
    pluginRegistry.providers.push({
      pluginId: "test-plugin",
      pluginName: "Test Plugin",
      source: "test",
      provider: {
        id: "test-provider",
        label: "Test Provider",
        auth: [],
        routingCapabilities: ["chat", "embedding"],
        transcribeAudio: async () => ({ text: "transcribed" }),
      },
    });
    setActivePluginRegistry(pluginRegistry);

    const registry = buildMediaUnderstandingRegistry();
    const provider = getMediaUnderstandingProvider("test-provider", registry);

    expect(provider?.capabilities ?? []).not.toContain("audio");
  });
});
