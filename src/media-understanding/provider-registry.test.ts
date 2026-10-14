// Provider registry tests cover runtime provider loading, normalization aliases,
// manifest-only image capability, and config-derived image providers.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildMediaUnderstandingRegistry,
  getMediaUnderstandingProvider,
} from "./provider-registry.js";
import type { MediaUnderstandingProvider } from "./types.js";

const resolvePluginCapabilityProvidersMock = vi.hoisted(() => vi.fn());

vi.mock("../plugins/capability-provider-runtime.js", () => ({
  resolvePluginCapabilityProviders: resolvePluginCapabilityProvidersMock,
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
    resolvePluginCapabilityProvidersMock.mockReset();
    resolvePluginCapabilityProvidersMock.mockReturnValue([]);
  });

  it("preserves partial native overrides for dispatch", () => {
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
    expect(provider.describeImages).toBeUndefined();
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
    expect(glmProvider.describeImage).toBeUndefined();
    expect(glmProvider.describeImages).toBeUndefined();
    expect(textOnlyProvider).toBeUndefined();
  });
});
