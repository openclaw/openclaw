import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ThinkingCatalogEntry, ThinkLevel } from "./thinking.shared.js";

const providerRuntimeMocks = vi.hoisted(() => ({
  resolveProviderThinkingProfile: vi.fn(),
}));

vi.mock("../plugins/provider-thinking.js", () => ({
  resolveEffectiveThinkingProfile: providerRuntimeMocks.resolveProviderThinkingProfile,
}));

const {
  listThinkingLevelLabels,
  listThinkingLevelOptions,
  listThinkingLevels,
  isThinkingLevelSupported,
  formatThinkingLevels,
  resolveSupportedThinkingLevel,
  resolveThinkingDefaultForModel,
} = await import("./thinking.js");

beforeEach(() => {
  providerRuntimeMocks.resolveProviderThinkingProfile.mockReset();
  providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue(undefined);
});

function catalogFor(
  provider: string,
  id: string,
  entry: Omit<ThinkingCatalogEntry, "provider" | "id">,
): ThinkingCatalogEntry[] {
  return [{ provider, id, ...entry }];
}

function mockQwenThinkingCatalog(id: string) {
  providerRuntimeMocks.resolveProviderThinkingProfile.mockImplementation(({ context }) =>
    context.reasoning === true && context.compat?.thinkingFormat === "qwen-chat-template"
      ? {
          levels: [{ id: "off" }, { id: "low", label: "on" }],
          defaultLevel: "off",
        }
      : undefined,
  );
  return [
    {
      provider: "vllm",
      id,
      reasoning: true,
      compat: { thinkingFormat: "qwen-chat-template" },
    },
  ];
}

describe("listThinkingLevels", () => {
  it.each<{
    owner: "unowned" | "plugin";
    agentRuntime?: string;
    maxCap?: null;
    expected: boolean;
    api?: string;
    thinkingFormat?: string;
  }>([
    { owner: "unowned", agentRuntime: "openclaw", maxCap: undefined, expected: true },
    { owner: "plugin", agentRuntime: "openclaw", maxCap: undefined, expected: true },
    { owner: "plugin", agentRuntime: "openclaw", maxCap: null, expected: false },
    { owner: "plugin", agentRuntime: "codex", maxCap: undefined, expected: false },
    { owner: "plugin", agentRuntime: "auto", expected: true },
    { owner: "plugin", expected: true },
    ...["qwen", "qwen-chat-template", "zai"].flatMap((thinkingFormat) =>
      (thinkingFormat === "qwen"
        ? ["openai-completions", "openai-responses"]
        : ["openai-completions"]
      ).map((api) => ({
        owner: "plugin" as const,
        agentRuntime: "openclaw",
        api,
        thinkingFormat,
        expected: api === "openai-responses",
      })),
    ),
  ])(
    "projects mapped Max for $owner $agentRuntime $api $thinkingFormat with cap=$maxCap",
    ({ owner, agentRuntime, maxCap, expected, api = "openai-completions", thinkingFormat }) => {
      if (owner === "plugin") {
        providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue({
          levels: [{ id: "off" }, { id: "high" }],
        });
      }
      const catalog = [
        {
          provider: "mapped-provider",
          id: "mapped-model",
          api,
          reasoning: true,
          thinkingLevelMap: maxCap === null ? { max: null } : undefined,
          compat: {
            thinkingFormat,
            supportedReasoningEfforts: ["ProviderLow", "ProviderHigh"],
            reasoningEffortMap: { high: "ProviderLow", MAX: "ProviderHigh" },
          },
        },
      ];

      expect(
        listThinkingLevels("mapped-provider", "mapped-model", catalog, agentRuntime).includes(
          "max",
        ),
      ).toBe(expected);
    },
  );

  it("uses provider thinking profiles for xhigh support", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue({
      levels: [{ id: "off" }, { id: "low" }, { id: "xhigh" }],
    });

    expect(listThinkingLevels("demo", "demo-model")).toContain("xhigh");
  });

  it("uses the base levels without a provider", () => {
    expect(listThinkingLevels(undefined, "gpt-4.1-mini")).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
  });

  it("passes the effective agent runtime into provider thinking profiles", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockImplementation(({ context }) => ({
      levels: [
        { id: "off" },
        { id: "max" },
        ...(context.agentRuntime === "openclaw" ? [{ id: "ultra" as const }] : []),
      ],
    }));

    expect(listThinkingLevels("openai", "gpt-5.6-luna", undefined, "openclaw")).toContain("ultra");
    expect(listThinkingLevels("openai", "gpt-5.6-luna", undefined, "codex")).toContain("ultra");
    expect(providerRuntimeMocks.resolveProviderThinkingProfile).toHaveBeenLastCalledWith({
      provider: "openai",
      context: expect.objectContaining({ agentRuntime: "codex" }),
    });
  });

  it("can clamp from active provider facts without public artifact fallback", () => {
    expect(
      resolveSupportedThinkingLevel({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        level: "medium",
        providerPolicySource: "active",
      }),
    ).toBe("medium");
    expect(providerRuntimeMocks.resolveProviderThinkingProfile).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "deepseek" }),
      { allowPublicArtifactFallback: false },
    );
  });

  it("preserves provider profile ids and labels", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue({
      levels: [{ id: "off" }, { id: "adaptive", label: "auto" }, { id: "max", label: "maximum" }],
      defaultLevel: "adaptive",
    });

    expect(listThinkingLevelOptions("demo", "demo-model")).toEqual([
      { id: "off", label: "off" },
      { id: "adaptive", label: "auto" },
      { id: "max", label: "maximum" },
    ]);
  });

  it("applies explicit model opt-outs before selecting a provider default", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue({
      levels: ["off", "low", "medium", "high", "ultra"].map((id) => ({ id })),
      defaultLevel: "high",
    });
    const catalog = catalogFor("demo", "demo-model", {
      reasoning: true,
      thinkingLevelMap: { off: null, high: null },
    });

    expect(listThinkingLevels("demo", "demo-model", catalog)).toEqual(["low", "medium", "ultra"]);
    expect(resolveThinkingDefaultForModel({ provider: "demo", model: "demo-model", catalog })).toBe(
      "medium",
    );
  });

  it("treats catalog reasoning=false as an explicit thinking opt-out", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue({
      levels: [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }],
      defaultLevel: "medium",
    });
    const catalog = catalogFor("google", "gemma-4-26b-a4b-it", {
      reasoning: false,
    });

    expect(listThinkingLevels("google", "gemma-4-26b-a4b-it", catalog)).toEqual(["off"]);
    expect(
      isThinkingLevelSupported({
        provider: "google",
        model: "gemma-4-26b-a4b-it",
        level: "medium",
        catalog,
      }),
    ).toBe(false);
    expect(
      resolveThinkingDefaultForModel({
        provider: "google",
        model: "gemma-4-26b-a4b-it",
        catalog,
      }),
    ).toBe("off");
  });

  it("uses materialized runtime capabilities for thinking", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockImplementation(({ context }) => ({
      levels:
        context.reasoning === true
          ? [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }]
          : [{ id: "off" }],
      defaultLevel: context.reasoning === true ? "medium" : "off",
    }));
    const catalog = [{ provider: "demo", id: "demo-model", reasoning: true }];

    expect(listThinkingLevels("demo", "demo-model", catalog, "demo-cli")).toEqual([
      "off",
      "low",
      "medium",
      "high",
    ]);
  });

  it("keeps a configured logical reasoning opt-out authoritative", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue({
      levels: [{ id: "off" }, { id: "low" }],
    });
    const catalog = [
      ...catalogFor("demo", "demo-model", { reasoning: false, configuredReasoning: false }),
      { provider: "demo-cli", id: "demo-model", reasoning: true },
    ];

    expect(listThinkingLevels("demo", "demo-model", catalog, "demo-cli")).toEqual(["off"]);
  });

  it("preserves provider-authoritative thinking profiles over stale catalog reasoning", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue({
      levels: [{ id: "off" }, { id: "minimal" }, { id: "low" }, { id: "medium" }],
      preserveWhenCatalogReasoningFalse: true,
    });
    const catalog = catalogFor("google", "gemini-3-flash-preview", {
      reasoning: false,
    });

    expect(
      isThinkingLevelSupported({
        provider: "google",
        model: "gemini-3-flash-preview",
        level: "low",
        catalog,
      }),
    ).toBe(true);
    expect(
      resolveSupportedThinkingLevel({
        provider: "google",
        model: "gemini-3-flash-preview",
        level: "low",
        catalog,
      }),
    ).toBe("low");
  });

  it("passes catalog reasoning into provider thinking profiles for support checks", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockImplementation(({ context }) => ({
      levels:
        context.reasoning === true
          ? [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }, { id: "max" }]
          : [{ id: "off" }],
      defaultLevel: "off",
    }));
    const catalog = [{ provider: "ollama", id: "gpt-oss:20b", name: "gpt-oss", reasoning: true }];

    expect(
      isThinkingLevelSupported({
        provider: "ollama",
        model: "gpt-oss:20b",
        level: "max",
        catalog,
      }),
    ).toBe(true);
    expect(formatThinkingLevels("ollama", "gpt-oss:20b", ", ", catalog)).toBe(
      "off, low, medium, high, max",
    );
    expect(
      resolveSupportedThinkingLevel({
        provider: "ollama",
        model: "gpt-oss:20b",
        level: "max",
        catalog,
      }),
    ).toBe("max");
  });

  it("passes catalog compat into provider thinking profiles", () => {
    const catalog = mockQwenThinkingCatalog("Qwen/Qwen3-8B");

    expect(listThinkingLevelLabels("vllm", "Qwen/Qwen3-8B", catalog)).toEqual(["off", "on"]);
    for (const level of ["high", "adaptive"] as const) {
      expect(
        resolveSupportedThinkingLevel({
          provider: "vllm",
          model: "Qwen/Qwen3-8B",
          level,
          catalog,
        }),
      ).toBe("low");
    }
  });

  it("uses canonical Fable params when no provider thinking profile exists", () => {
    const catalog = catalogFor("microsoft-foundry", "company-fable", {
      api: "anthropic-messages",
      reasoning: false,
      params: { canonicalModelId: "claude-fable-5" },
    });

    expect(listThinkingLevels("microsoft-foundry", "company-fable", catalog)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(
      resolveThinkingDefaultForModel({
        provider: "microsoft-foundry",
        model: "company-fable",
        catalog,
      }),
    ).toBe("medium");
    expect(
      resolveSupportedThinkingLevel({
        provider: "microsoft-foundry",
        model: "company-fable",
        level: "adaptive",
        catalog,
      }),
    ).toBe("medium");
  });

  it("exposes Claude Opus xhigh on custom anthropic-messages providers without a plugin profile", () => {
    // Regression for openclaw#91975: a renamed provider serving Claude Opus over
    // anthropic-messages used to fall back to a base profile (no xhigh) and silently
    // clamp `--thinking xhigh` to `off`.
    const catalog = catalogFor("jdcloud-anthropic", "claude-opus-4.7-hq", {
      api: "anthropic-messages",
      reasoning: true,
    });

    expect(listThinkingLevels("jdcloud-anthropic", "claude-opus-4.7-hq", catalog)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "adaptive",
      "high",
      "xhigh",
      "max",
    ]);
    expect(
      isThinkingLevelSupported({
        provider: "jdcloud-anthropic",
        model: "claude-opus-4.7-hq",
        level: "xhigh",
        catalog,
      }),
    ).toBe(true);
    expect(
      resolveSupportedThinkingLevel({
        provider: "jdcloud-anthropic",
        model: "claude-opus-4.7-hq",
        level: "xhigh",
        catalog,
      }),
    ).toBe("xhigh");
  });

  it("intentionally suppresses compat-driven xhigh for non-Claude anthropic-messages rows", () => {
    // Even when the catalog explicitly advertises xhigh via compat, a non-Claude
    // model on the anthropic-messages transport stays on the Claude base set.
    // The transport itself doesn't carry a generic xhigh contract — only Claude
    // families do — so the catalog signal is intentionally suppressed here.
    const catalog = catalogFor("jdcloud-anthropic", "some-non-claude-model", {
      api: "anthropic-messages",
      reasoning: true,
      compat: { supportedReasoningEfforts: ["xhigh"] },
    });

    expect(listThinkingLevels("jdcloud-anthropic", "some-non-claude-model", catalog)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
  });

  it("does not infer the Claude profile without an anthropic-messages catalog row", () => {
    // Same provider id, but the catalog row says openai-completions — must NOT
    // grant Claude levels to a non-Anthropic transport.
    const catalog = catalogFor("jdcloud-anthropic", "claude-opus-4.7-hq", {
      api: "openai-completions",
      reasoning: true,
    });

    expect(listThinkingLevels("jdcloud-anthropic", "claude-opus-4.7-hq", catalog)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
  });

  it("matches native Anthropic max parity for adaptive Claude on custom anthropic-messages providers", () => {
    // Adaptive Claude families (e.g. claude-sonnet-4-6) take the adaptive-default
    // branch in resolveClaudeThinkingProfile, which only exposes `max` when
    // includeNativeMax is set. The fallback must pass the same option the
    // bundled anthropic plugin uses, otherwise custom providers silently lose
    // `max` parity with the native Anthropic policy.
    const catalog = catalogFor("jdcloud-anthropic", "claude-sonnet-4-6", {
      api: "anthropic-messages",
      reasoning: true,
    });

    expect(listThinkingLevels("jdcloud-anthropic", "claude-sonnet-4-6", catalog)).toContain("max");
    expect(
      isThinkingLevelSupported({
        provider: "jdcloud-anthropic",
        model: "claude-sonnet-4-6",
        level: "max",
        catalog,
      }),
    ).toBe(true);
  });

  it("preserves explicit provider opt-outs for canonical Fable aliases", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue({
      levels: [{ id: "off" }],
      defaultLevel: "off",
    });
    const catalog = catalogFor("claude-cli", "company-fable", {
      api: "anthropic-messages",
      reasoning: true,
      params: { canonicalModelId: "claude-fable-5" },
    });

    expect(listThinkingLevels("claude-cli", "company-fable", catalog)).toEqual(["off"]);
  });

  it("honors provider-owned thinking maps before compat and derives OpenClaw Ultra", () => {
    const catalog = catalogFor("custom", "reasoning-model", {
      reasoning: true,
      thinkingLevelMap: {
        off: "none",
        minimal: null,
        low: null,
        medium: null,
        high: "high",
        xhigh: null,
        max: "max",
      },
      compat: { supportedReasoningEfforts: ["high", "xhigh", "max"] },
    });

    expect(listThinkingLevels("custom", "reasoning-model", catalog, "openclaw")).toEqual([
      "off",
      "high",
      "max",
      "ultra",
    ]);
    expect(
      resolveThinkingDefaultForModel({
        provider: "custom",
        model: "reasoning-model",
        catalog,
        agentRuntime: "openclaw",
      }),
    ).toBe("high");
    expect(listThinkingLevels("custom", "reasoning-model", catalog, "codex")).toEqual([
      "off",
      "high",
      "max",
      "ultra",
    ]);
  });

  it("exposes mapped advanced efforts without requiring duplicate compat metadata", () => {
    const catalog = catalogFor("custom", "mapped-model", {
      reasoning: true,
      thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
    });

    expect(listThinkingLevels("custom", "mapped-model", catalog, "openclaw")).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
  });

  it("matches provider-qualified catalog ids for provider thinking profiles", () => {
    const catalog = mockQwenThinkingCatalog("vllm/Qwen/Qwen3-8B");

    expect(listThinkingLevelLabels("vllm", "Qwen/Qwen3-8B", catalog)).toEqual(["off", "on"]);
    expect(
      resolveSupportedThinkingLevel({
        provider: "vllm",
        model: "Qwen/Qwen3-8B",
        level: "high",
        catalog,
      }),
    ).toBe("low");
  });

  it("does not treat provider-native effort labels as user thinking aliases", () => {
    const catalog = catalogFor("custom", "native-efforts", {
      api: "openai-completions",
      reasoning: true,
      compat: { supportedReasoningEfforts: ["high", "XHIGH", "MAX", "extra-high", "auto"] },
    });

    expect(listThinkingLevels("custom", "native-efforts", catalog, "openclaw")).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "ultra",
    ]);
    expect(
      isThinkingLevelSupported({
        provider: "custom",
        model: "native-efforts",
        level: "max",
        catalog,
        agentRuntime: "openclaw",
      }),
    ).toBe(false);
  });

  it("uses advanced catalog efforts and derives OpenClaw Ultra from Max", () => {
    const catalog = catalogFor("myazure", "gpt-5.6-sol", {
      api: "openai-responses",
      reasoning: true,
      compat: {
        supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      },
    });

    expect(listThinkingLevels("myazure", "gpt-5.6-sol", catalog, "openclaw")).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    expect(
      isThinkingLevelSupported({
        provider: "myazure",
        model: "gpt-5.6-sol",
        level: "max",
        catalog,
        agentRuntime: "openclaw",
      }),
    ).toBe(true);
    expect(
      isThinkingLevelSupported({
        provider: "myazure",
        model: "gpt-5.6-sol",
        level: "ultra",
        catalog,
        agentRuntime: "openclaw",
      }),
    ).toBe(true);
    expect(listThinkingLevels("myazure", "gpt-5.6-sol", catalog, "codex")).toContain("ultra");
  });

  it("preserves catalog-advertised Ultra for non-OpenClaw runtimes", () => {
    const catalog = catalogFor("myazure", "gpt-5.6-sol", {
      reasoning: true,
      compat: {
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      },
    });

    expect(listThinkingLevels("myazure", "gpt-5.6-sol", catalog, "codex")).toContain("ultra");
    expect(
      isThinkingLevelSupported({
        provider: "myazure",
        model: "gpt-5.6-sol",
        level: "ultra",
        catalog,
        agentRuntime: "codex",
      }),
    ).toBe(true);
  });

  it("does not let catalog xhigh compat override binary thinking providers", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue({
      levels: [
        { id: "off", label: "off" },
        { id: "low", label: "on" },
      ],
    });
    const catalog = catalogFor("zai", "glm-4.7", {
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
      compat: { supportedReasoningEfforts: ["xhigh"] },
    });

    expect(listThinkingLevels("zai", "glm-4.7", catalog)).toEqual(["off", "low"]);
    expect(listThinkingLevelLabels("zai", "glm-4.7", catalog)).toEqual(["off", "on"]);
  });

  it.each<{
    name: string;
    levels: ThinkLevel[];
    defaultLevel?: ThinkLevel;
    requested: ThinkLevel;
    expected: ThinkLevel;
  }>([
    {
      name: "xhigh below a supported max",
      levels: ["off", "minimal", "low", "medium", "high", "adaptive", "max"],
      requested: "xhigh",
      expected: "high",
    },
    {
      name: "adaptive with an off default",
      levels: ["off", "minimal", "low", "medium", "high"],
      defaultLevel: "off",
      requested: "adaptive",
      expected: "medium",
    },
    {
      name: "adaptive with a non-off provider default",
      levels: ["low", "medium", "high", "xhigh", "max"],
      defaultLevel: "high",
      requested: "adaptive",
      expected: "high",
    },
    {
      name: "below-range request on a no-off profile",
      levels: ["low", "medium", "high"],
      requested: "off",
      expected: "low",
    },
  ])("clamps $name", ({ levels, defaultLevel, requested, expected }) => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue({
      levels: levels.map((id) => ({ id })),
      defaultLevel,
    });
    expect(
      resolveSupportedThinkingLevel({ provider: "demo", model: "demo-model", level: requested }),
    ).toBe(expected);
  });
});
