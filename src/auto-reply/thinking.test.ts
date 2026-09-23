import { beforeEach, describe, expect, it, vi } from "vitest";

const providerRuntimeMocks = vi.hoisted(() => ({
  resolveProviderThinkingProfile: vi.fn(),
}));

vi.mock("../plugins/provider-thinking.js", () => ({
  resolveEffectiveThinkingProfile: providerRuntimeMocks.resolveProviderThinkingProfile,
}));

const {
  createThinkingCatalogResolver,
  resolveThinkingProfile,
  listThinkingLevelLabels,
  normalizeReasoningLevel,
  normalizeThinkLevel,
  resolveThinkingDefaultForModel,
} = await import("./thinking.js");

beforeEach(() => {
  providerRuntimeMocks.resolveProviderThinkingProfile.mockReset();
  providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue(undefined);
});

describe("normalizeThinkLevel", () => {
  it("normalizes the documented none alias to off", () => {
    expect(normalizeThinkLevel("none")).toBe("off");
  });

  it("accepts mid as medium", () => {
    expect(normalizeThinkLevel("mid")).toBe("medium");
  });

  it("accepts xhigh aliases", () => {
    expect(normalizeThinkLevel("xhigh")).toBe("xhigh");
    expect(normalizeThinkLevel("x-high")).toBe("xhigh");
    expect(normalizeThinkLevel("x_high")).toBe("xhigh");
    expect(normalizeThinkLevel("x high")).toBe("xhigh");
  });

  it("accepts extra-high aliases as xhigh", () => {
    expect(normalizeThinkLevel("extra-high")).toBe("xhigh");
    expect(normalizeThinkLevel("extra high")).toBe("xhigh");
    expect(normalizeThinkLevel("extra_high")).toBe("xhigh");
    expect(normalizeThinkLevel("  extra high  ")).toBe("xhigh");
  });

  it("does not over-match nearby xhigh words", () => {
    expect(normalizeThinkLevel("extra-highest")).toBeUndefined();
    expect(normalizeThinkLevel("xhigher")).toBeUndefined();
  });

  it("accepts on as low", () => {
    expect(normalizeThinkLevel("on")).toBe("low");
  });

  it("accepts adaptive and auto aliases", () => {
    expect(normalizeThinkLevel("adaptive")).toBe("adaptive");
    expect(normalizeThinkLevel("auto")).toBe("adaptive");
    expect(normalizeThinkLevel("Adaptive")).toBe("adaptive");
  });

  it("accepts max as its own level", () => {
    expect(normalizeThinkLevel("max")).toBe("max");
    expect(normalizeThinkLevel("MAX")).toBe("max");
  });

  it("keeps explicit Ultra distinct from the legacy ultrathink alias", () => {
    expect(normalizeThinkLevel("ultra")).toBe("ultra");
    expect(normalizeThinkLevel("ULTRA")).toBe("ultra");
    expect(normalizeThinkLevel("ultrathink")).toBe("high");
  });
});

describe("prepared thinking catalog identity", () => {
  it.each([
    { provider: " demo ", model: " Mixed ", expected: ["off"], expectedDefault: "off" },
    { provider: "DEMO", model: "Mixed", expected: ["off"], expectedDefault: "off" },
    { provider: "demo", model: "demo/Mixed", expected: ["high"], expectedDefault: "high" },
    {
      provider: "demo",
      model: "mixed",
      expected: ["off", "minimal", "low", "medium", "high"],
      expectedDefault: "off",
    },
    {
      provider: "demo-cli",
      model: "Mixed",
      expected: ["off", "minimal", "low", "medium", "high"],
      expectedDefault: "off",
    },
    { provider: "demo", model: "DEMO/Mixed", expected: ["off"], expectedDefault: "off" },
    {
      provider: "demo/team",
      model: "Reader",
      expected: ["off", "minimal", "low", "medium", "high"],
      expectedDefault: "off",
    },
  ])(
    "prefers the literal catalog identity for profile and default at $provider/$model",
    ({ provider, model, expected, expectedDefault }) => {
      const catalog = [
        {
          provider: " DEMO ",
          id: "demo/Mixed",
          reasoning: true,
          thinkingLevelMap: { off: null, minimal: null, low: null, medium: null },
        },
        { provider: "demo", id: "Mixed", reasoning: false },
        { provider: "demo", id: "Mixed", reasoning: true },
        { provider: "demo", id: "DEMO/Mixed", reasoning: false },
        {
          provider: "demo",
          id: "team/Reader",
          reasoning: true,
          thinkingLevelMap: { off: null, minimal: null, low: null, medium: null },
        },
      ];
      const catalogResolver = createThinkingCatalogResolver(catalog);
      for (const source of [{ catalog }, { catalog, catalogResolver }, { catalogResolver }]) {
        const params = { provider, model, ...source };
        const profile = resolveThinkingProfile(params);
        expect(profile.levels.map(({ id }) => id)).toEqual(expected);
        expect(resolveThinkingDefaultForModel(params)).toBe(expectedDefault);
      }
    },
  );
});

describe("listThinkingLevelLabels", () => {
  it("uses provider thinking profiles for binary thinking providers", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue({
      levels: [
        { id: "off", label: "off" },
        { id: "low", label: "on" },
      ],
    });

    expect(listThinkingLevelLabels("demo", "demo-model")).toEqual(["off", "on"]);
  });

  it("does not assume binary thinking without provider runtime", () => {
    expect(listThinkingLevelLabels("zai", "glm-4.7")).toContain("low");
    expect(listThinkingLevelLabels("zai", "glm-4.7")).not.toContain("on");
  });

  it("returns full levels for non-ZAI", () => {
    expect(listThinkingLevelLabels("openai", "gpt-4.1-mini")).toContain("low");
    expect(listThinkingLevelLabels("openai", "gpt-4.1-mini")).not.toContain("on");
  });
});

describe("resolveThinkingDefaultForModel", () => {
  it("uses provider thinking profiles for default thinking levels", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue({
      levels: [{ id: "off" }, { id: "adaptive" }],
      defaultLevel: "adaptive",
    });

    expect(resolveThinkingDefaultForModel({ provider: "demo", model: "demo-model" })).toBe(
      "adaptive",
    );
  });

  it("does not apply provider-advertised adaptive defaults across Bedrock id variants", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockImplementation(
      ({ provider, context }) =>
        provider === "amazon-bedrock" && context.modelId === "claude-sonnet-4-6"
          ? { levels: [{ id: "off" }, { id: "adaptive" }], defaultLevel: "adaptive" }
          : undefined,
    );

    expect(
      resolveThinkingDefaultForModel({ provider: "aws-bedrock", model: "claude-sonnet-4-6" }),
    ).toBe("off");
  });

  it("does not assume adaptive defaults without provider runtime", () => {
    expect(
      resolveThinkingDefaultForModel({ provider: "anthropic", model: "claude-opus-4-6" }),
    ).toBe("off");
    expect(
      resolveThinkingDefaultForModel({ provider: "aws-bedrock", model: "claude-sonnet-4-6" }),
    ).toBe("off");
  });

  it("defaults reasoning-capable catalog models to medium", () => {
    expect(
      resolveThinkingDefaultForModel({
        provider: "openai",
        model: "gpt-5.4",
        catalog: [{ provider: "openai", id: "gpt-5.4", reasoning: true }],
      }),
    ).toBe("medium");
  });

  it("remaps implicit reasoning defaults to the strongest supported level at or below medium", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockImplementation(({ provider }) =>
      provider === "demo-binary" ? { levels: [{ id: "off" }, { id: "low" }] } : undefined,
    );

    expect(
      resolveThinkingDefaultForModel({
        provider: "demo-binary",
        model: "demo-model",
        catalog: [{ provider: "demo-binary", id: "demo-model", reasoning: true }],
      }),
    ).toBe("low");
  });

  it("keeps catalog reasoning context when remapping implicit reasoning defaults", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockImplementation(
      ({ provider, context }) =>
        provider === "demo-contextual" && context.reasoning
          ? { levels: [{ id: "off" }, { id: "low" }, { id: "medium" }] }
          : provider === "demo-contextual"
            ? { levels: [{ id: "off" }] }
            : undefined,
    );

    expect(
      resolveThinkingDefaultForModel({
        provider: "demo-contextual",
        model: "demo-model",
        catalog: [{ provider: "demo-contextual", id: "demo-model", reasoning: true }],
      }),
    ).toBe("medium");
  });

  it("defaults to off when no adaptive or reasoning hint is present", () => {
    expect(
      resolveThinkingDefaultForModel({
        provider: "openai",
        model: "gpt-4.1-mini",
        catalog: [{ provider: "openai", id: "gpt-4.1-mini", reasoning: false }],
      }),
    ).toBe("off");
  });

  it("respects provider-declared 'off' default for reasoning-capable models", () => {
    // Providers like Ollama declare defaultLevel:"off" even for reasoning=true models
    // because thinking must be explicitly opted in, not activated by the global default.
    providerRuntimeMocks.resolveProviderThinkingProfile.mockImplementation(({ provider }) =>
      provider === "ollama"
        ? {
            levels: [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }, { id: "max" }],
            defaultLevel: "off",
          }
        : undefined,
    );

    expect(
      resolveThinkingDefaultForModel({
        provider: "ollama",
        model: "gemma4",
        catalog: [{ provider: "ollama", id: "gemma4", reasoning: true }],
      }),
    ).toBe("off");
  });
});

describe("normalizeReasoningLevel", () => {
  it("accepts on/off", () => {
    expect(normalizeReasoningLevel("on")).toBe("on");
    expect(normalizeReasoningLevel("off")).toBe("off");
  });

  it("accepts show/hide", () => {
    expect(normalizeReasoningLevel("show")).toBe("on");
    expect(normalizeReasoningLevel("hide")).toBe("off");
  });

  it("accepts stream", () => {
    expect(normalizeReasoningLevel("stream")).toBe("stream");
    expect(normalizeReasoningLevel("streaming")).toBe("stream");
  });
});
