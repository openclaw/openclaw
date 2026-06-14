// Verifies provider thinking profile lookup across active and bundled policy surfaces.
import { beforeEach, describe, expect, it, vi } from "vitest";

type ResolveBundledProviderPolicySurfaces =
  typeof import("./provider-public-artifacts.js").resolveBundledProviderPolicySurfaces;

const policySurfaceMocks = vi.hoisted(() => ({
  resolveBundledProviderPolicySurfaces: vi.fn<ResolveBundledProviderPolicySurfaces>(() => []),
}));

vi.mock("./provider-public-artifacts.js", () => ({
  resolveBundledProviderPolicySurfaces: policySurfaceMocks.resolveBundledProviderPolicySurfaces,
}));

const { resolveProviderThinkingProfile } = await import("./provider-thinking.js");

beforeEach(() => {
  delete (globalThis as typeof globalThis & Record<symbol, unknown>)[
    Symbol.for("openclaw.pluginRegistryState")
  ];
  policySurfaceMocks.resolveBundledProviderPolicySurfaces.mockReset();
  policySurfaceMocks.resolveBundledProviderPolicySurfaces.mockReturnValue([]);
});

describe("provider thinking policy", () => {
  it("continues across API-ref bundled policy surfaces until one returns a profile", () => {
    const firstResolveThinkingProfile = vi.fn(() => null);
    const secondResolveThinkingProfile = vi.fn(() => ({
      levels: [{ id: "xhigh" as const }],
      defaultLevel: "xhigh" as const,
    }));
    policySurfaceMocks.resolveBundledProviderPolicySurfaces.mockReturnValue([
      { resolveThinkingProfile: firstResolveThinkingProfile },
      { resolveThinkingProfile: secondResolveThinkingProfile },
    ]);

    expect(
      resolveProviderThinkingProfile({
        provider: "custom-openai",
        context: {
          provider: "custom-openai",
          api: "openai-responses",
          modelId: "gpt-5.5",
          reasoning: true,
        },
      }),
    ).toEqual({ levels: [{ id: "xhigh" }], defaultLevel: "xhigh" });

    expect(policySurfaceMocks.resolveBundledProviderPolicySurfaces).toHaveBeenCalledWith(
      "custom-openai",
      { providerRefs: ["openai-responses"] },
    );
    expect(firstResolveThinkingProfile).toHaveBeenCalledWith({
      provider: "custom-openai",
      api: "openai-responses",
      modelId: "gpt-5.5",
      reasoning: true,
    });
    expect(secondResolveThinkingProfile).toHaveBeenCalledWith({
      provider: "custom-openai",
      api: "openai-responses",
      modelId: "gpt-5.5",
      reasoning: true,
    });
  });
});
