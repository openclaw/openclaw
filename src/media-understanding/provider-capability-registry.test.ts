// Capability registry tests cover plugin-owned capability precedence and
// config-derived image-provider fallback registration.
import { describe, expect, it, vi } from "vitest";
import { buildMediaUnderstandingCapabilityRegistryAsync } from "./provider-capability-registry.js";

// mock-isolation: Config capability inference uses an empty inventory without loading plugins.
vi.mock("../plugins/capability-provider-acquisition.js", () => ({
  acquirePluginCapabilityProviders: vi.fn(async () => ({
    providers: [],
    release: async () => {},
  })),
}));

describe("media-understanding capability registry", () => {
  it("auto-registers config providers with image-capable models", async () => {
    const registry = await buildMediaUnderstandingCapabilityRegistryAsync({
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
});
