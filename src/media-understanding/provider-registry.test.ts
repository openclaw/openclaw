// Provider registry tests cover runtime provider loading, normalization aliases,
// manifest-only hook hydration, and config-derived image providers.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  describeImageWithModel,
  describeImageWithModelPayloadTransform,
  describeImagesWithModel,
  describeImagesWithModelPayloadTransform,
  extractStructuredWithImageModel,
  extractStructuredWithImageModelPayloadTransform,
} from "./image-runtime.js";
import {
  buildMediaUnderstandingRegistry,
  getMediaUnderstandingProvider,
} from "./provider-registry.js";
import type { MediaUnderstandingProvider } from "./types.js";

const resolvePluginCapabilityProviderMock = vi.hoisted(() => vi.fn());
const resolvePluginCapabilityProvidersMock = vi.hoisted(() => vi.fn());

vi.mock("../plugins/capability-provider-runtime.js", () => ({
  resolvePluginCapabilityProvider: resolvePluginCapabilityProviderMock,
  resolvePluginCapabilityProviders: resolvePluginCapabilityProvidersMock,
}));

// Identity assertions below compare against these stand-ins; the transform
// variants also record the (request, transform) pair hydration hands them.
vi.mock("./image-runtime.js", () => ({
  describeImageWithModel: vi.fn(),
  describeImageWithModelPayloadTransform: vi.fn(),
  describeImagesWithModel: vi.fn(),
  describeImagesWithModelPayloadTransform: vi.fn(),
  extractStructuredWithImageModel: vi.fn(),
  extractStructuredWithImageModelPayloadTransform: vi.fn(),
}));

function createMediaProvider(
  params: Pick<MediaUnderstandingProvider, "id" | "capabilities"> &
    Partial<MediaUnderstandingProvider>,
): MediaUnderstandingProvider {
  return params;
}

function requireMediaProvider(
  registry: Map<string, MediaUnderstandingProvider>,
  providerId: string,
): MediaUnderstandingProvider {
  const provider = getMediaUnderstandingProvider(providerId, registry);
  if (!provider) {
    throw new Error(`expected media-understanding provider ${providerId}`);
  }
  return provider;
}

describe("media-understanding provider registry", () => {
  beforeEach(() => {
    resolvePluginCapabilityProviderMock.mockReset();
    resolvePluginCapabilityProviderMock.mockReturnValue(undefined);
    resolvePluginCapabilityProvidersMock.mockReset();
    resolvePluginCapabilityProvidersMock.mockReturnValue([]);
  });

  it("loads media providers from the capability runtime", () => {
    resolvePluginCapabilityProvidersMock.mockReturnValue([
      createMediaProvider({ id: "groq", capabilities: ["image", "audio"] }),
      createMediaProvider({ id: "deepgram", capabilities: ["audio"] }),
    ]);

    const registry = buildMediaUnderstandingRegistry();

    expect(requireMediaProvider(registry, "groq").id).toBe("groq");
    expect(typeof requireMediaProvider(registry, "groq").describeImage).toBe("function");
    expect(typeof requireMediaProvider(registry, "groq").describeImages).toBe("function");
    expect(requireMediaProvider(registry, "deepgram").id).toBe("deepgram");
    expect(resolvePluginCapabilityProvidersMock).toHaveBeenCalledWith({
      key: "mediaUnderstandingProviders",
      cfg: undefined,
    });
  });

  it("hydrates manifest-only image providers with model-backed image hooks", () => {
    resolvePluginCapabilityProvidersMock.mockReturnValue([
      createMediaProvider({
        id: "zai",
        capabilities: ["image"],
        defaultModels: { image: "glm-4.6v" },
      }),
    ]);

    const registry = buildMediaUnderstandingRegistry();
    const provider = requireMediaProvider(registry, "zai");

    expect(provider.defaultModels?.image).toBe("glm-4.6v");
    expect(provider.describeImage).toBe(describeImageWithModel);
    expect(provider.describeImages).toBe(describeImagesWithModel);
    expect(provider.extractStructured).toBe(extractStructuredWithImageModel);
  });

  it("hydrates structured extraction from the shared runtime, never a provider's own describeImages", () => {
    // Shared extraction pins its instructions to the system channel inside the
    // shared completion; routing it through a bespoke describeImages would lose
    // that guarantee.
    const describeImage = vi.fn();
    const describeImages = vi.fn();
    resolvePluginCapabilityProvidersMock.mockReturnValue([
      createMediaProvider({
        id: "anthropic",
        capabilities: ["image"],
        describeImage,
        describeImages,
      }),
    ]);

    const provider = requireMediaProvider(buildMediaUnderstandingRegistry(), "anthropic");

    expect(provider.describeImage).toBe(describeImage);
    expect(provider.describeImages).toBe(describeImages);
    expect(provider.extractStructured).toBe(extractStructuredWithImageModel);
  });

  it("applies a declared payload transform to every hydrated shared hook", async () => {
    const imagePayloadTransform = vi.fn();
    resolvePluginCapabilityProvidersMock.mockReturnValue([
      createMediaProvider({ id: "opencode", capabilities: ["image"], imagePayloadTransform }),
    ]);

    const provider = requireMediaProvider(buildMediaUnderstandingRegistry(), "opencode");
    await provider.describeImage?.({} as never);
    await provider.describeImages?.({} as never);
    await provider.extractStructured?.({} as never);

    expect(describeImageWithModelPayloadTransform).toHaveBeenCalledWith({}, imagePayloadTransform);
    expect(describeImagesWithModelPayloadTransform).toHaveBeenCalledWith({}, imagePayloadTransform);
    expect(extractStructuredWithImageModelPayloadTransform).toHaveBeenCalledWith(
      {},
      imagePayloadTransform,
    );
  });

  it("keeps a provider's bespoke structured extraction implementation", () => {
    const extractStructured = vi.fn();
    resolvePluginCapabilityProvidersMock.mockReturnValue([
      createMediaProvider({ id: "codex", capabilities: ["image"], extractStructured }),
    ]);

    const provider = requireMediaProvider(buildMediaUnderstandingRegistry(), "codex");

    expect(provider.extractStructured).toBe(extractStructured);
  });

  it("does not hydrate structured extraction for providers without image capability", () => {
    resolvePluginCapabilityProvidersMock.mockReturnValue([
      createMediaProvider({ id: "deepgram", capabilities: ["audio"] }),
    ]);

    const provider = requireMediaProvider(buildMediaUnderstandingRegistry(), "deepgram");

    expect(provider.extractStructured).toBeUndefined();
  });

  it("resolves the requested provider by id when another provider is already active", () => {
    // A warm gateway keeps another media provider active, Logbook's visionModel
    // names anthropic, and anthropic is in neither the active set nor
    // tools.media.models: it must still load (#119772).
    const describeImages = vi.fn();
    resolvePluginCapabilityProvidersMock.mockReturnValue([
      createMediaProvider({ id: "openai", capabilities: ["image"] }),
    ]);
    resolvePluginCapabilityProviderMock.mockReturnValue(
      createMediaProvider({ id: "anthropic", capabilities: ["image"], describeImages }),
    );

    const registry = buildMediaUnderstandingRegistry(undefined, undefined, undefined, "anthropic");

    const anthropic = requireMediaProvider(registry, "anthropic");
    expect(anthropic.describeImages).toBe(describeImages);
    expect(anthropic.extractStructured).toBe(extractStructuredWithImageModel);
    expect(requireMediaProvider(registry, "openai").id).toBe("openai");
    expect(resolvePluginCapabilityProviderMock).toHaveBeenCalledWith({
      key: "mediaUnderstandingProviders",
      providerId: "anthropic",
      cfg: undefined,
    });
  });

  it("does not re-resolve a requested provider already registered under an alias", () => {
    resolvePluginCapabilityProvidersMock.mockReturnValue([
      createMediaProvider({ id: "google", capabilities: ["image"] }),
    ]);

    const registry = buildMediaUnderstandingRegistry(undefined, undefined, undefined, "gemini");

    expect(requireMediaProvider(registry, "gemini").id).toBe("google");
    expect(resolvePluginCapabilityProviderMock).not.toHaveBeenCalled();
  });

  it("prefers the resolved provider's own hooks over a config-derived image entry", () => {
    // Same ordering as the cold path: plugin providers land before config
    // synthetics, so a provider's request-transforming describeImages survives.
    const describeImages = vi.fn();
    resolvePluginCapabilityProvidersMock.mockReturnValue([
      createMediaProvider({ id: "openai", capabilities: ["image"] }),
    ]);
    resolvePluginCapabilityProviderMock.mockReturnValue(
      createMediaProvider({ id: "anthropic", capabilities: ["image"], describeImages }),
    );
    const cfg = {
      models: {
        providers: {
          anthropic: { models: [{ id: "claude-sonnet-5", input: ["text", "image"] }] },
        },
      },
    } as never;

    const registry = buildMediaUnderstandingRegistry(undefined, cfg, undefined, "anthropic");

    expect(requireMediaProvider(registry, "anthropic").describeImages).toBe(describeImages);
  });

  it("leaves an unresolvable requested provider out of the registry", () => {
    resolvePluginCapabilityProvidersMock.mockReturnValue([
      createMediaProvider({ id: "openai", capabilities: ["image"] }),
    ]);

    const registry = buildMediaUnderstandingRegistry(undefined, undefined, undefined, "anthropic");

    expect(getMediaUnderstandingProvider("anthropic", registry)).toBeUndefined();
  });

  it("resets earlier custom hooks when a prepared owner explicitly requests generic hooks", () => {
    const customImage = vi.fn(async () => ({ text: "custom image" }));
    const customImages = vi.fn(async () => ({ text: "custom images" }));
    const registry = buildMediaUnderstandingRegistry(undefined, undefined, [
      createMediaProvider({
        id: "zai",
        capabilities: ["image"],
        describeImage: customImage,
        describeImages: customImages,
      }),
      createMediaProvider({
        id: "zai",
        capabilities: ["image"],
        defaultModels: { image: "glm-4.6v" },
        describeImage: undefined,
        describeImages: undefined,
      }),
    ]);

    const provider = requireMediaProvider(registry, "zai");
    expect(provider.defaultModels?.image).toBe("glm-4.6v");
    expect(provider.describeImage).toBe(describeImageWithModel);
    expect(provider.describeImages).toBe(describeImagesWithModel);
  });

  it("keeps partial explicit overrides ahead of hydrated prepared hooks", () => {
    const overrideImage = vi.fn(async () => ({ text: "override image" }));
    const registry = buildMediaUnderstandingRegistry(
      {
        zai: createMediaProvider({
          id: "zai",
          capabilities: ["image"],
          describeImage: overrideImage,
        }),
      },
      undefined,
      [createMediaProvider({ id: "zai", capabilities: ["image"] })],
    );

    const provider = requireMediaProvider(registry, "zai");
    expect(provider.describeImage).toBe(overrideImage);
    expect(provider.describeImages).toBe(describeImagesWithModel);
  });

  it("keeps provider id normalization behavior for capability providers", () => {
    resolvePluginCapabilityProvidersMock.mockReturnValue([
      createMediaProvider({ id: "google", capabilities: ["image", "audio", "video"] }),
    ]);

    const registry = buildMediaUnderstandingRegistry();

    expect(requireMediaProvider(registry, "gemini").id).toBe("google");
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
    const glmProvider = requireMediaProvider(registry, "glm");
    const textOnlyProvider = getMediaUnderstandingProvider("textOnly", registry);

    expect(glmProvider.id).toBe("glm");
    expect(glmProvider.capabilities).toEqual(["image"]);
    expect(typeof glmProvider.describeImage).toBe("function");
    expect(typeof glmProvider.describeImages).toBe("function");
    expect(textOnlyProvider).toBeUndefined();
  });

  it("does not override capability providers when config also has image-capable models", async () => {
    resolvePluginCapabilityProvidersMock.mockReturnValue([
      createMediaProvider({
        id: "google",
        capabilities: ["image", "audio", "video"],
        describeImage: async () => ({ text: "plugin image" }),
        transcribeAudio: async () => ({ text: "plugin audio" }),
      }),
    ]);
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
    const provider = requireMediaProvider(registry, "google");

    expect(provider.capabilities).toEqual(["image", "audio", "video"]);
    expect(provider.describeImage).toBeTypeOf("function");
    if (!provider.describeImage) {
      throw new Error("expected google describeImage provider hook");
    }
    expect(provider.transcribeAudio).toBeTypeOf("function");
    if (!provider.transcribeAudio) {
      throw new Error("expected google transcribeAudio provider hook");
    }
    expect(await provider.describeImage({} as never)).toEqual({ text: "plugin image" });
    expect(await provider.transcribeAudio({} as never)).toEqual({ text: "plugin audio" });
    expect(resolvePluginCapabilityProvidersMock).toHaveBeenCalledWith({
      key: "mediaUnderstandingProviders",
      cfg,
    });
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
