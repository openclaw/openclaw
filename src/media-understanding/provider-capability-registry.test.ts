// Capability registry tests cover plugin-owned capability precedence and
// config-derived image-provider fallback registration.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { validateConfigObjectRaw } from "../config/validation-core.js";
import { resolvePluginCapabilityProvider } from "../plugins/capability-provider-runtime.js";
import { buildMediaUnderstandingCapabilityRegistry } from "./provider-capability-registry.js";

vi.mock("../plugins/capability-provider-runtime.js", () => ({
  resolvePluginCapabilityProvider: vi.fn(() => undefined),
}));

const resolveProviders = vi.mocked(resolvePluginCapabilityProvider);

describe("media-understanding capability registry", () => {
  beforeEach(() => {
    resolveProviders.mockReturnValue(undefined);
  });

  it("auto-registers config providers with image-capable models", () => {
    const registry = buildMediaUnderstandingCapabilityRegistry({
      tools: { media: { models: [{ provider: "glm" }, { provider: "textOnly" }] } },
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
    } as never);

    expect(registry.get("glm")?.capabilities).toEqual(["image"]);
    expect(registry.get("textOnly")).toBeUndefined();
  });

  it("accepts source model overrides before runtime defaults during secrets preparation", () => {
    const validated = validateConfigObjectRaw({
      tools: { media: { models: [{ provider: "openai" }] } },
      models: { providers: { openai: { models: [{ id: "source-model", name: "Source model" }] } } },
    });
    if (!validated.ok) {
      throw new Error("expected source config to validate");
    }

    const registry = buildMediaUnderstandingCapabilityRegistry(validated.config);
    expect(registry.get("openai")).toBeUndefined();
  });
});
