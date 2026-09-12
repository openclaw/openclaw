import { beforeEach, describe, expect, it, vi } from "vitest";

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
  it("uses provider thinking profiles for xhigh support", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue({
      levels: [{ id: "off" }, { id: "low" }, { id: "xhigh" }],
    });

    expect(listThinkingLevels("demo", "demo-model")).toContain("xhigh");
  });

  it("uses provider thinking profiles for xhigh labels", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue({
      levels: [{ id: "off" }, { id: "low" }, { id: "xhigh" }],
    });

    expect(listThinkingLevelLabels("demo", "demo-model")).toContain("xhigh");
  });

  it("includes xhigh for provider-advertised models", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockImplementation(
      ({ provider, context }) =>
        (provider === "openai" &&
          ["gpt-5.4", "gpt-5.4-pro", "gpt-5.3-codex-spark"].includes(context.modelId)) ||
        (provider === "github-copilot" && context.modelId === "gpt-5.4")
          ? { levels: [{ id: "off" }, { id: "low" }, { id: "xhigh" }] }
          : undefined,
    );

    for (const [provider, model] of [
      ["openai", "gpt-5.4"],
      ["openai", "gpt-5.4-pro"],
      ["openai", "gpt-5.3-codex-spark"],
      ["github-copilot", "gpt-5.4"],
    ] as const) {
      expect(listThinkingLevels(provider, model)).toContain("xhigh");
    }
  });

  it("excludes xhigh for non-codex models", () => {
    expect(listThinkingLevels(undefined, "gpt-4.1-mini")).not.toContain("xhigh");
  });

  it("does not include max without provider support", () => {
    expect(listThinkingLevels("openai", "gpt-5.4")).not.toContain("max");
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
    expect(listThinkingLevels("openai", "gpt-5.6-luna", undefined, "codex")).not.toContain("ultra");
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

  it("does not include adaptive without provider support", () => {
    expect(listThinkingLevels(undefined, "gpt-4.1-mini")).not.toContain("adaptive");
    expect(listThinkingLevels("openai", "gpt-5.4")).not.toContain("adaptive");
  });

  it("uses provider thinking profiles for adaptive and max support", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockImplementation(({ provider }) =>
      provider === "anthropic"
        ? { levels: [{ id: "off" }, { id: "adaptive" }, { id: "max" }] }
        : undefined,
    );

    expect(listThinkingLevels("anthropic", "claude-opus-4-6")).toContain("adaptive");
    expect(listThinkingLevels("anthropic", "claude-opus-4-7")).toContain("max");
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

  it("uses provider thinking profiles as the canonical policy", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue({
      levels: [{ id: "off" }, { id: "low", label: "on" }],
      defaultLevel: "off",
    });
    expect(listThinkingLevels("demo", "demo-model")).toEqual(["off", "low"]);
    expect(listThinkingLevelLabels("demo", "demo-model")).toEqual(["off", "on"]);
  });

  it("treats catalog reasoning=false as an explicit thinking opt-out", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue({
      levels: [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }],
      defaultLevel: "medium",
    });
    const catalog = [
      {
        provider: "google",
        id: "gemma-4-26b-a4b-it",
        name: "Gemma 4 26B",
        reasoning: false,
      },
    ];

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

  it.each([
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-5",
    "claude-fable-5",
    "claude-sonnet-4-6",
  ])("uses materialized CLI runtime capabilities for %s thinking", (model) => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockImplementation(({ context }) => ({
      levels:
        context.reasoning === true
          ? [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }]
          : [{ id: "off" }],
      defaultLevel: context.reasoning === true ? "medium" : "off",
    }));
    const catalog = [{ provider: "anthropic", id: model, name: model, reasoning: true }];

    expect(listThinkingLevels("anthropic", model, catalog, "claude-cli")).toEqual([
      "off",
      "low",
      "medium",
      "high",
    ]);
  });

  it("keeps a materialized runtime reasoning opt-out authoritative", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue({
      levels: [{ id: "off" }, { id: "low" }],
    });
    const catalog = [{ provider: "demo", id: "demo-model", name: "Demo", reasoning: false }];

    expect(listThinkingLevels("demo", "demo-model", catalog, "demo-cli")).toEqual(["off"]);
  });

  it("keeps a configured logical reasoning opt-out authoritative", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue({
      levels: [{ id: "off" }, { id: "low" }],
    });
    const catalog = [
      {
        provider: "demo",
        id: "demo-model",
        name: "Demo",
        reasoning: false,
        configuredReasoning: false,
      },
      { provider: "demo-cli", id: "demo-model", name: "Demo CLI", reasoning: true },
    ];

    expect(listThinkingLevels("demo", "demo-model", catalog, "demo-cli")).toEqual(["off"]);
  });

  it("preserves provider-authoritative thinking profiles over stale catalog reasoning", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue({
      levels: [{ id: "off" }, { id: "minimal" }, { id: "low" }, { id: "medium" }],
      preserveWhenCatalogReasoningFalse: true,
    });
    const catalog = [
      {
        provider: "google",
        id: "gemini-3-flash-preview",
        name: "Gemini 3 Flash Preview",
        reasoning: false,
      },
    ];

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
    const catalog = [
      {
        provider: "microsoft-foundry",
        id: "company-fable",
        api: "anthropic-messages",
        reasoning: false,
        params: { canonicalModelId: "claude-fable-5" },
      },
    ];

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
    const catalog = [
      {
        provider: "jdcloud-anthropic",
        id: "claude-opus-4.7-hq",
        api: "anthropic-messages",
        reasoning: true,
      },
    ];

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

  it("does not invent xhigh for non-Claude models on anthropic-messages routes", () => {
    const catalog = [
      {
        provider: "jdcloud-anthropic",
        id: "some-non-claude-model",
        api: "anthropic-messages",
        reasoning: true,
      },
    ];

    expect(listThinkingLevels("jdcloud-anthropic", "some-non-claude-model", catalog)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
  });

  it("intentionally suppresses compat-driven xhigh for non-Claude anthropic-messages rows", () => {
    // Even when the catalog explicitly advertises xhigh via compat, a non-Claude
    // model on the anthropic-messages transport stays on the Claude base set.
    // The transport itself doesn't carry a generic xhigh contract — only Claude
    // families do — so the catalog signal is intentionally suppressed here.
    const catalog = [
      {
        provider: "jdcloud-anthropic",
        id: "some-non-claude-model",
        api: "anthropic-messages",
        reasoning: true,
        compat: { supportedReasoningEfforts: ["xhigh"] },
      },
    ];

    expect(listThinkingLevels("jdcloud-anthropic", "some-non-claude-model", catalog)).not.toContain(
      "xhigh",
    );
  });

  it("does not infer the Claude profile without an anthropic-messages catalog row", () => {
    // Same provider id, but the catalog row says openai-completions — must NOT
    // grant Claude levels to a non-Anthropic transport.
    const catalog = [
      {
        provider: "jdcloud-anthropic",
        id: "claude-opus-4.7-hq",
        api: "openai-completions",
        reasoning: true,
      },
    ];

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
    const catalog = [
      {
        provider: "jdcloud-anthropic",
        id: "claude-sonnet-4-6",
        api: "anthropic-messages",
        reasoning: true,
      },
    ];

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

  it("preserves provider-specific profiles for Fable Messages routes", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue({
      levels: [{ id: "off" }, { id: "low" }],
      defaultLevel: "off",
    });

    expect(
      listThinkingLevels("proxy", "company-fable", [
        {
          provider: "proxy",
          id: "company-fable",
          api: "anthropic-messages",
          reasoning: true,
          params: { canonicalModelId: "claude-fable-5" },
        },
      ]),
    ).toEqual(["off", "low"]);
  });

  it("does not infer the Fable contract without an Anthropic Messages catalog row", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue({
      levels: [{ id: "off" }, { id: "low" }],
      defaultLevel: "off",
    });

    expect(listThinkingLevels("openrouter", "anthropic/claude-fable-5")).toEqual(["off", "low"]);
  });

  it("does not apply the Fable profile to OpenAI-compatible catalog rows", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue({
      levels: [{ id: "off" }, { id: "low" }, { id: "high" }],
      defaultLevel: "off",
    });

    expect(
      listThinkingLevels("openrouter", "anthropic/claude-fable-5", [
        {
          provider: "openrouter",
          id: "anthropic/claude-fable-5",
          api: "openai-completions",
          reasoning: true,
        },
      ]),
    ).toEqual(["off", "low", "high"]);
  });

  it("preserves explicit provider opt-outs for canonical Fable aliases", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue({
      levels: [{ id: "off" }],
      defaultLevel: "off",
    });
    const catalog = [
      {
        provider: "claude-cli",
        id: "company-fable",
        api: "anthropic-messages",
        reasoning: true,
        params: { canonicalModelId: "claude-fable-5" },
      },
    ];

    expect(listThinkingLevels("claude-cli", "company-fable", catalog)).toEqual(["off"]);
  });

  it("uses generic thinking levels when a provider has no custom profile", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue(null);

    expect(
      listThinkingLevels("vllm", "reasoning-model", [
        {
          provider: "vllm",
          id: "reasoning-model",
          reasoning: true,
        },
      ]),
    ).toEqual(["off", "minimal", "low", "medium", "high"]);
  });

  it("honors provider-owned thinking maps before compat and derives OpenClaw Ultra", () => {
    const catalog = [
      {
        provider: "custom",
        id: "reasoning-model",
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
      },
    ];

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
    ]);
  });

  it("exposes mapped advanced efforts without requiring duplicate compat metadata", () => {
    const catalog = [
      {
        provider: "custom",
        id: "mapped-model",
        reasoning: true,
        thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
      },
    ];

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

  it("uses catalog compat reasoning efforts to expose xhigh for configured custom models", () => {
    const catalog = [
      {
        provider: "gmn",
        id: "gpt-5.4",
        name: "GPT 5.4 via GMN",
        reasoning: true,
        compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
      },
    ];

    expect(listThinkingLevels("gmn", "gpt-5.4", catalog)).toContain("xhigh");
    expect(formatThinkingLevels("gmn", "gpt-5.4", ", ", catalog)).toBe(
      "off, minimal, low, medium, high, xhigh",
    );
    expect(
      isThinkingLevelSupported({
        provider: "gmn",
        model: "gpt-5.4",
        level: "xhigh",
        catalog,
      }),
    ).toBe(true);
  });

  it("uses advanced catalog efforts and derives OpenClaw Ultra from Max", () => {
    const catalog = [
      {
        provider: "myazure",
        id: "gpt-5.6-sol",
        name: "GPT 5.6 Sol via Azure",
        api: "openai-responses",
        reasoning: true,
        compat: {
          supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
        },
      },
    ];

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
    expect(listThinkingLevels("myazure", "gpt-5.6-sol", catalog, "codex")).not.toContain("ultra");
  });

  it("preserves catalog-advertised Ultra for non-OpenClaw runtimes", () => {
    const catalog = [
      {
        provider: "myazure",
        id: "gpt-5.6-sol",
        reasoning: true,
        compat: {
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        },
      },
    ];

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
    const catalog = [
      {
        provider: "zai",
        id: "glm-4.7",
        name: "GLM 4.7",
        thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
        compat: { supportedReasoningEfforts: ["xhigh"] },
      },
    ];

    expect(listThinkingLevels("zai", "glm-4.7", catalog)).toEqual(["off", "low"]);
    expect(listThinkingLevelLabels("zai", "glm-4.7", catalog)).toEqual(["off", "on"]);
  });

  it("maps stale unsupported levels to the largest profile level", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue({
      levels: [{ id: "off" }, { id: "high" }],
    });

    expect(
      resolveSupportedThinkingLevel({
        provider: "demo",
        model: "demo-model",
        level: "max",
      }),
    ).toBe("high");
  });

  it("maps xhigh to high for provider profiles with max but no xhigh", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockImplementation(({ provider }) =>
      provider === "anthropic"
        ? {
            levels: [
              { id: "off" },
              { id: "minimal" },
              { id: "low" },
              { id: "medium" },
              { id: "high" },
              { id: "adaptive" },
              { id: "max" },
            ],
          }
        : undefined,
    );

    expect(
      resolveSupportedThinkingLevel({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        level: "xhigh",
      }),
    ).toBe("high");
  });

  it("maps unsupported adaptive to medium and unsupported xhigh to high", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue({
      levels: [{ id: "off" }, { id: "minimal" }, { id: "low" }, { id: "medium" }, { id: "high" }],
      defaultLevel: "off",
    });

    expect(
      resolveSupportedThinkingLevel({
        provider: "openai",
        model: "gpt-5.4",
        level: "adaptive",
      }),
    ).toBe("medium");
    expect(
      resolveSupportedThinkingLevel({
        provider: "openai",
        model: "gpt-4.1-mini",
        level: "xhigh",
      }),
    ).toBe("high");
  });

  it("uses the provider default for a stored adaptive level when adaptive is not selectable", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue({
      levels: ["low", "medium", "high", "xhigh", "max"].map((id) => ({ id })),
      defaultLevel: "high",
    });

    expect(
      resolveSupportedThinkingLevel({ provider: "proxy", model: "reasoner", level: "adaptive" }),
    ).toBe("high");
  });

  it("clamps a below-range request down to the cheapest level on a no-off profile", () => {
    providerRuntimeMocks.resolveProviderThinkingProfile.mockReturnValue({
      levels: [{ id: "low" }, { id: "medium" }, { id: "high" }],
    });

    expect(
      resolveSupportedThinkingLevel({
        provider: "demo-noff",
        model: "demo-model",
        level: "off",
      }),
    ).toBe("low");
  });
});
