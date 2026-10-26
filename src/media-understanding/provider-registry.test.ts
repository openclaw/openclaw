import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { mediaModels } from "./media-config.test-support.js";
import {
  buildMediaUnderstandingRegistry,
  getMediaUnderstandingProvider,
} from "./provider-registry.js";
import type { MediaUnderstandingProvider } from "./types.js";

const resolvePluginCapabilityProvidersMock = vi.hoisted(() => vi.fn());

vi.mock("../plugins/capability-provider-runtime.js", () => ({
  resolvePluginCapabilityProviders: resolvePluginCapabilityProvidersMock,
}));

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
      models: mediaModels("acme", "vision", ["text", "image"]),
    };
    const registered = Object.freeze({
      id: "acme",
      capabilities: ["audio"],
      inheritConfiguredImageCapability: true,
    } satisfies MediaUnderstandingProvider);
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
    const overrideImage = vi.fn(async () => ({ text: "override image" }));
    const override = {
      id: "acme",
      capabilities: ["image"],
      describeImage: overrideImage,
    } satisfies MediaUnderstandingProvider;
    const provider = requireMediaProvider(
      buildMediaUnderstandingRegistry({ acme: override }, cfg, [registered]),
      "acme",
    );
    expect(provider.capabilities).toEqual(["image"]);
    expect(provider.describeImage).toBe(overrideImage);
    expect(provider.describeImages).toBeUndefined();
    expect(registered.capabilities).toEqual(["audio"]);
  });

  it("auto-registers media-understanding for config providers with image-capable models (#51392)", () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          ...mediaModels("glm", "glm-4.6v", ["text", "image"]).providers,
          ...mediaModels("textOnly", "text-model", ["text"]).providers,
        },
      },
    };
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
