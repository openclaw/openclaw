import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { generateImage, listRuntimeImageGenerationProviders } from "./runtime.js";
import type { ImageGenerationProvider } from "./types.js";

const mocks = vi.hoisted(() => {
  const debug = vi.fn();
  return {
    createSubsystemLogger: vi.fn(() => ({ debug })),
    describeFailoverError: vi.fn(),
    getImageGenerationProvider: vi.fn<
      (providerId: string, config?: OpenClawConfig) => ImageGenerationProvider | undefined
    >(() => undefined),
    getProviderEnvVars: vi.fn<(providerId: string) => string[]>(() => []),
    isFailoverError: vi.fn<(err: unknown) => boolean>(() => false),
    listImageGenerationProviders: vi.fn<(config?: OpenClawConfig) => ImageGenerationProvider[]>(
      () => [],
    ),
    parseImageGenerationModelRef: vi.fn<
      (raw?: string) => { provider: string; model: string } | undefined
    >((raw?: string) => {
      const trimmed = raw?.trim();
      if (!trimmed) {
        return undefined;
      }
      const slash = trimmed.indexOf("/");
      if (slash <= 0 || slash === trimmed.length - 1) {
        return undefined;
      }
      return {
        provider: trimmed.slice(0, slash),
        model: trimmed.slice(slash + 1),
      };
    }),
    resolveAgentModelFallbackValues: vi.fn<(value: unknown) => string[]>(() => []),
    resolveAgentModelPrimaryValue: vi.fn<(value: unknown) => string | undefined>(() => undefined),
    debug,
  };
});

vi.mock("../agents/failover-error.js", () => ({
  describeFailoverError: mocks.describeFailoverError,
  isFailoverError: mocks.isFailoverError,
}));
vi.mock("../config/model-input.js", () => ({
  resolveAgentModelFallbackValues: mocks.resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue: mocks.resolveAgentModelPrimaryValue,
}));
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: mocks.createSubsystemLogger,
}));
vi.mock("../secrets/provider-env-vars.js", () => ({
  getProviderEnvVars: mocks.getProviderEnvVars,
}));
vi.mock("./model-ref.js", () => ({
  parseImageGenerationModelRef: mocks.parseImageGenerationModelRef,
}));
vi.mock("./provider-registry.js", () => ({
  getImageGenerationProvider: mocks.getImageGenerationProvider,
  listImageGenerationProviders: mocks.listImageGenerationProviders,
}));

describe("image-generation runtime", () => {
  beforeEach(() => {
    mocks.createSubsystemLogger.mockClear();
    mocks.describeFailoverError.mockReset();
    mocks.getImageGenerationProvider.mockReset();
    mocks.getProviderEnvVars.mockReset();
    mocks.getProviderEnvVars.mockReturnValue([]);
    mocks.isFailoverError.mockReset();
    mocks.isFailoverError.mockReturnValue(false);
    mocks.listImageGenerationProviders.mockReset();
    mocks.listImageGenerationProviders.mockReturnValue([]);
    mocks.parseImageGenerationModelRef.mockClear();
    mocks.resolveAgentModelFallbackValues.mockReset();
    mocks.resolveAgentModelFallbackValues.mockReturnValue([]);
    mocks.resolveAgentModelPrimaryValue.mockReset();
    mocks.resolveAgentModelPrimaryValue.mockReturnValue(undefined);
    mocks.debug.mockReset();
  });

  it("generates images through the active image-generation provider", async () => {
    const authStore = { version: 1, profiles: {} } as const;
    let seenAuthStore: unknown;
    mocks.resolveAgentModelPrimaryValue.mockReturnValue("image-plugin/img-v1");
    const provider: ImageGenerationProvider = {
      id: "image-plugin",
      capabilities: {
        generate: {},
        edit: { enabled: false },
      },
      async generateImage(req: { authStore?: unknown }) {
        seenAuthStore = req.authStore;
        return {
          images: [
            {
              buffer: Buffer.from("png-bytes"),
              mimeType: "image/png",
              fileName: "sample.png",
            },
          ],
          model: "img-v1",
        };
      },
    };
    mocks.getImageGenerationProvider.mockReturnValue(provider);

    const result = await generateImage({
      cfg: {
        agents: {
          defaults: {
            imageGenerationModel: { primary: "image-plugin/img-v1" },
          },
        },
      } as OpenClawConfig,
      prompt: "draw a cat",
      agentDir: "/tmp/agent",
      authStore,
    });

    expect(result.provider).toBe("image-plugin");
    expect(result.model).toBe("img-v1");
    expect(result.attempts).toEqual([]);
    expect(seenAuthStore).toEqual(authStore);
    expect(result.images).toEqual([
      {
        buffer: Buffer.from("png-bytes"),
        mimeType: "image/png",
        fileName: "sample.png",
      },
    ]);
  });

  it("lists runtime image-generation providers through the provider registry", () => {
    const providers: ImageGenerationProvider[] = [
      {
        id: "image-plugin",
        defaultModel: "img-v1",
        models: ["img-v1", "img-v2"],
        capabilities: {
          generate: {
            supportsResolution: true,
          },
          edit: {
            enabled: true,
            maxInputImages: 3,
          },
          geometry: {
            resolutions: ["1K", "2K"],
          },
        },
        generateImage: async () => ({
          images: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
        }),
      },
    ];
    mocks.listImageGenerationProviders.mockReturnValue(providers);

    expect(listRuntimeImageGenerationProviders({ config: {} as OpenClawConfig })).toEqual(
      providers,
    );
    expect(mocks.listImageGenerationProviders).toHaveBeenCalledWith({} as OpenClawConfig);
  });

  it("builds a generic config hint without hardcoded provider ids", async () => {
    mocks.listImageGenerationProviders.mockReturnValue([
      {
        id: "vision-one",
        defaultModel: "paint-v1",
        capabilities: {
          generate: {},
          edit: { enabled: false },
        },
        generateImage: async () => ({
          images: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
        }),
      },
      {
        id: "vision-two",
        defaultModel: "paint-v2",
        capabilities: {
          generate: {},
          edit: { enabled: false },
        },
        generateImage: async () => ({
          images: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
        }),
      },
    ]);
    mocks.getProviderEnvVars.mockImplementation((providerId: string) => {
      if (providerId === "vision-one") {
        return ["VISION_ONE_API_KEY"];
      }
      if (providerId === "vision-two") {
        return ["VISION_TWO_API_KEY"];
      }
      return [];
    });

    const promise = generateImage({ cfg: {} as OpenClawConfig, prompt: "draw a cat" });

    await expect(promise).rejects.toThrow("No image-generation model configured.");
    await expect(promise).rejects.toThrow(
      'Set agents.defaults.imageGenerationModel.primary to a provider/model like "vision-one/paint-v1".',
    );
    await expect(promise).rejects.toThrow("vision-one: VISION_ONE_API_KEY");
    await expect(promise).rejects.toThrow("vision-two: VISION_TWO_API_KEY");
  });
});
