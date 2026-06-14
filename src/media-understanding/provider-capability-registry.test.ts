// Capability registry tests cover plugin-owned capability precedence and
// config-derived image-provider fallback registration.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePluginCapabilityProviders } from "../plugins/capability-provider-runtime.js";
import { buildMediaUnderstandingCapabilityRegistry } from "./provider-capability-registry.js";

vi.mock("../plugins/capability-provider-runtime.js", () => ({
  resolvePluginCapabilityProviders: vi.fn(() => []),
}));

const resolveProviders = vi.mocked(resolvePluginCapabilityProviders);

describe("media-understanding capability registry", () => {
  beforeEach(() => {
    resolveProviders.mockReturnValue([]);
  });

  it("auto-registers config providers with image-capable models", () => {
    const registry = buildMediaUnderstandingCapabilityRegistry({
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

  it("keeps plugin-owned capabilities ahead of config auto-registration", () => {
    resolveProviders.mockReturnValue([{ id: "google", capabilities: ["audio"] } as never]);

    const registry = buildMediaUnderstandingCapabilityRegistry({
      models: {
        providers: {
          google: {
            models: [{ id: "custom-gemini", input: ["text", "image"] }],
          },
        },
      },
    } as never);

    expect(registry.get("google")?.capabilities).toEqual(["audio"]);
  });

  it("uses plugin-owned model overrides before config auto-registers alias providers", () => {
    resolveProviders.mockReturnValue([
      {
        id: "dashscope",
        capabilities: ["image"],
        modelCapabilityOverrides: { nonImageModelFamilies: ["qwen3.7-max"] },
      } as never,
    ]);

    const registry = buildMediaUnderstandingCapabilityRegistry({
      models: {
        providers: {
          dashscope: {
            models: [{ id: "qwen3.7-max", input: ["text", "image"] }],
          },
        },
      },
    } as never);

    expect(registry.get("dashscope")?.modelCapabilityOverrides).toEqual({
      nonImageModelFamilies: ["qwen3.7-max"],
    });
    expect(registry.get("dashscope")?.capabilities).toEqual(["image"]);
  });
});
