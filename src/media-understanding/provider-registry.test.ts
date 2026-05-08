import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import {
  buildMediaUnderstandingRegistry,
  getMediaUnderstandingProvider,
} from "./provider-registry.js";

vi.mock("../plugins/capability-provider-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/capability-provider-runtime.js")>(
    "../plugins/capability-provider-runtime.js",
  );
  const runtime =
    await vi.importActual<typeof import("../plugins/runtime.js")>("../plugins/runtime.js");
  return {
    ...actual,
    resolvePluginCapabilityProviders: ({ key }: { key: string }) =>
      key !== "mediaUnderstandingProviders"
        ? []
        : (() => {
            const activeProviders =
              runtime
                .getActivePluginRegistry()
                ?.mediaUnderstandingProviders.map((entry) => entry.provider) ?? [];
            return activeProviders.length > 0
              ? activeProviders
              : [
                  { id: "groq", capabilities: ["image", "audio"] },
                  { id: "deepgram", capabilities: ["audio"] },
                ];
          })(),
  };
});

describe("media-understanding provider registry", () => {
  afterEach(() => {
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  it("loads bundled providers by default when no active registry is present", () => {
    const registry = buildMediaUnderstandingRegistry();
    expect(getMediaUnderstandingProvider("groq", registry)?.id).toBe("groq");
    expect(getMediaUnderstandingProvider("deepgram", registry)?.id).toBe("deepgram");
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

  it("auto-registers media-understanding for config providers with image-capable models (#51392)", () => {
    const cfg = {
      models: {
        providers: {
          glm: {
            models: [{ id: "glm-4.6v", input: ["text", "image"] }],
          },
          textOnly: {
            models: [{ id: "text-model", input: ["text"] }],
          },
        },
      },
    } as never;
    const registry = buildMediaUnderstandingRegistry(undefined, cfg);
    const glmProvider = getMediaUnderstandingProvider("glm", registry);
    const textOnlyProvider = getMediaUnderstandingProvider("textOnly", registry);

    expect(glmProvider?.id).toBe("glm");
    expect(glmProvider?.capabilities).toEqual(["image"]);
    expect(glmProvider?.describeImage).toBeDefined();
    expect(glmProvider?.describeImages).toBeDefined();
    expect(textOnlyProvider).toBeUndefined();
  });

  it("does not override plugin-registered providers when config also has image-capable models", async () => {
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
      },
    });
    setActivePluginRegistry(pluginRegistry);

    const cfg = {
      models: {
        providers: {
          google: {
            models: [{ id: "custom-gemini", input: ["text", "image"] }],
          },
        },
      },
    } as never;

    const registry = buildMediaUnderstandingRegistry(undefined, cfg);
    const provider = getMediaUnderstandingProvider("google", registry);

    expect(provider?.capabilities).toEqual(["image", "audio", "video"]);
    expect(await provider?.describeImage?.({} as never)).toEqual({ text: "plugin image" });
    expect(await provider?.transcribeAudio?.({} as never)).toEqual({ text: "plugin audio" });
  });

  it("does not auto-register providers with audio or video only inputs", () => {
    const cfg = {
      models: {
        providers: {
          avOnly: {
            models: [
              { id: "audio-model", input: ["text", "audio"] },
              { id: "video-model", input: ["text", "video"] },
            ],
          },
        },
      },
    } as never;

    const registry = buildMediaUnderstandingRegistry(undefined, cfg);

    expect(getMediaUnderstandingProvider("avOnly", registry)).toBeUndefined();
  });
});
