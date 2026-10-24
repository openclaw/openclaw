// Provider registry tests cover runtime provider loading, normalization aliases,
// manifest-only image capability, and config-derived image providers.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
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

  it("adds configured image only for static opt-ins without mutating registrations or overrides", () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          acme: {
            baseUrl: "https://fixture.invalid",
            models: [
              {
                id: "vision",
                name: "Vision",
                input: ["text", "image"],
                reasoning: false,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                maxTokens: 1024,
              },
            ],
          },
        },
      },
    };
    const registered = Object.freeze(
      createMediaProvider({
        id: "acme",
        capabilities: ["audio"],
        inheritConfiguredImageCapability: true,
      }),
    );
    const projected = requireMediaProvider(
      buildMediaUnderstandingRegistry(undefined, cfg, [registered]),
      "acme",
    );
    expect(projected.capabilities).toEqual(["audio", "image"]);
    expect(projected).not.toBe(registered);
    expect(registered.capabilities).toEqual(["audio"]);
    expect(
      requireMediaProvider(buildMediaUnderstandingRegistry(undefined, {}, [registered]), "acme")
        .capabilities,
    ).toEqual(["audio"]);
    for (const inheritConfiguredImageCapability of [false, undefined]) {
      expect(
        requireMediaProvider(
          buildMediaUnderstandingRegistry(undefined, cfg, [
            { ...registered, inheritConfiguredImageCapability },
          ]),
          "acme",
        ).capabilities,
      ).toEqual(["audio"]);
    }
    expect(
      requireMediaProvider(
        buildMediaUnderstandingRegistry({ acme: { id: "acme", capabilities: ["video"] } }, cfg, [
          registered,
        ]),
        "acme",
      ).capabilities,
    ).toEqual(["video"]);
    expect(registered.capabilities).toEqual(["audio"]);
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
