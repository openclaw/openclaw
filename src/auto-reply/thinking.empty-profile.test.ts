import { beforeEach, describe, expect, it, vi } from "vitest";
const providerRuntimeMocks = vi.hoisted(() => ({ resolveProviderThinkingProfile: vi.fn() }));
vi.mock("../plugins/provider-thinking.js", () => ({
  resolveEffectiveThinkingProfile: providerRuntimeMocks.resolveProviderThinkingProfile,
}));
const {
  resolveThinkingProfile,
  listThinkingLevelOptions,
  listThinkingLevels,
  formatThinkingLevels,
  isThinkingLevelSupported,
} = await import("./thinking.js");
beforeEach(() => {
  providerRuntimeMocks.resolveProviderThinkingProfile.mockReset();
  providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue(undefined);
});

describe("known-empty provider thinking profiles", () => {
  it.each([
    { reasoning: undefined, api: undefined },
    { reasoning: true, api: "anthropic-messages" },
  ])("preserves known-empty provider levels with catalog context %j", ({ reasoning, api }) => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue({
      levels: [],
      defaultLevel: null,
    });
    const catalog = [
      {
        provider: "demo",
        id: "demo-model",
        api,
        reasoning,
        thinkingLevelMap: { xhigh: "xhigh", max: "max" },
        compat: { supportedReasoningEfforts: ["adaptive", "xhigh", "max", "ultra"] },
      },
    ];
    const params = { provider: "demo", model: "demo-model", catalog, agentRuntime: "openclaw" };

    expect(resolveThinkingProfile(params)).toEqual({ levels: [], defaultLevel: undefined });
    expect(listThinkingLevelOptions("demo", "demo-model", catalog, "openclaw")).toEqual([]);
    expect(formatThinkingLevels("demo", "demo-model", ", ", catalog, "openclaw")).toBe("");
    expect(isThinkingLevelSupported({ ...params, level: "off" })).toBe(false);
    expect(isThinkingLevelSupported({ ...params, level: "high" })).toBe(false);
  });

  it.each([
    { reasoning: false, configuredReasoning: undefined, preserve: false, expected: ["off"] },
    { reasoning: false, configuredReasoning: undefined, preserve: true, expected: [] },
    { reasoning: true, configuredReasoning: false, preserve: false, expected: ["off"] },
    { reasoning: true, configuredReasoning: false, preserve: true, expected: [] },
  ])(
    "keeps reasoning opt-out precedence for an empty profile: %j",
    ({ reasoning, configuredReasoning, preserve, expected }) => {
      providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue({
        levels: [],
        preserveWhenCatalogReasoningFalse: preserve,
      });
      const profile = resolveThinkingProfile({
        provider: "demo",
        model: "demo-model",
        catalog: [{ provider: "demo", id: "demo-model", reasoning }],
        configuredReasoning,
      });

      expect(profile.levels.map(({ id }) => id)).toEqual(expected);
      expect(profile.defaultLevel).toBe(preserve ? undefined : "off");
    },
  );

  it.each([undefined, null])(
    "keeps generic choices for an absent provider profile: %s",
    (profile) => {
      providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue(profile);

      expect(
        listThinkingLevels("demo", "demo-model", [
          { provider: "demo", id: "demo-model", reasoning: true },
        ]),
      ).toEqual(["off", "minimal", "low", "medium", "high"]);
    },
  );
});
