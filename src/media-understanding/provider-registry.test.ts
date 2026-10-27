import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { mediaModels } from "./media-config.test-support.js";
import {
  buildMediaUnderstandingRegistry,
  getMediaUnderstandingProvider,
} from "./provider-registry.js";

// mock-isolation: Test explicit registry entries without loading installed providers.
vi.mock("../plugins/capability-provider-runtime.js", () => ({
  resolvePluginCapabilityProviders: () => [],
}));

const cfg: OpenClawConfig = { models: mediaModels("acme", "vision", ["text", "image"]) };

describe("media-understanding provider registry", () => {
  it("preserves partial native overrides for dispatch", () => {
    const overrideImage = vi.fn(async () => ({ text: "override image" }));
    const registered = { id: "acme", capabilities: ["audio" as const] };
    expect(
      buildMediaUnderstandingRegistry(undefined, cfg, [registered]).get("acme")?.capabilities,
    ).toEqual(["audio"]);
    const registry = buildMediaUnderstandingRegistry(
      {
        acme: { id: "acme", capabilities: ["image"], describeImage: overrideImage },
      },
      cfg,
      [registered],
    );
    expect(getMediaUnderstandingProvider("acme", registry)).toMatchObject({
      capabilities: ["image"],
      describeImage: overrideImage,
    });
    expect(getMediaUnderstandingProvider("acme", registry)?.describeImages).toBeUndefined();
  });

  it("auto-registers media-understanding for config providers with image-capable models (#51392)", () => {
    const imageConfig: OpenClawConfig = {
      models: {
        providers: {
          ...mediaModels("glm", "glm-4.6v", ["text", "image"]).providers,
          ...mediaModels("textOnly", "text-model", ["text"]).providers,
        },
      },
    };
    const registry = buildMediaUnderstandingRegistry(undefined, imageConfig);
    const provider = getMediaUnderstandingProvider("glm", registry);
    expect(provider).toMatchObject({ id: "glm", capabilities: ["image"] });
    expect(provider?.describeImage).toBeUndefined();
    expect(provider?.describeImages).toBeUndefined();
    expect(getMediaUnderstandingProvider("textOnly", registry)).toBeUndefined();
  });
});
