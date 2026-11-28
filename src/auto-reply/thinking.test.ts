import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configuredModelCatalogEntry } from "../agents/model-catalog-entry.js";
import { overlayCatalogMetadata } from "../agents/model-catalog-metadata.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
import { applyModelDefaults } from "../config/defaults.js";
import type { ThinkingCatalogEntry, ThinkLevel } from "./thinking.shared.js";

const mocks = vi.hoisted(() => ({ profile: vi.fn() }));
vi.mock("../plugins/provider-thinking.js", () => ({
  resolveEffectiveThinkingProfile: mocks.profile,
}));
const {
  createThinkingCatalogResolver,
  formatThinkingLevels,
  isThinkingLevelSupported,
  listThinkingLevelLabels,
  listThinkingLevelOptions,
  listThinkingLevels,
  normalizeReasoningLevel,
  resolveProviderThinkingLevel,
  resolveSupportedThinkingLevel,
  resolveThinkingDefaultForModel,
  resolveThinkingProfile,
  resolveThinkingSelectionForModel,
} = await import("./thinking.js");

beforeEach(() => {
  mocks.profile.mockReset();
});

function thinkingModel(entry: Omit<ThinkingCatalogEntry, "provider" | "id"> = {}) {
  return {
    provider: "demo",
    model: "demo-model",
    catalog: [{ provider: "demo", id: "demo-model", ...entry }],
  };
}
const baseLevels = ["off", "minimal", "low", "medium", "high"];

describe("thinking normalization", () => {
  it("normalizes streaming reasoning visibility", () => {
    expect(normalizeReasoningLevel("streaming")).toBe("stream");
  });
});

describe("prepared catalog identity", () => {
  it.each([{ provider: "demo/team", model: "Reader", expected: baseLevels, defaultLevel: "off" }])(
    "preserves literal identity for $provider/$model",
    ({ provider, model, expected, defaultLevel }) => {
      const thinkingLevelMap = { off: null, minimal: null, low: null, medium: null };
      const catalog = [
        { provider: " DEMO ", id: "demo/Mixed", reasoning: true, thinkingLevelMap },
        { provider: "demo", id: "Mixed", reasoning: false },
        { provider: "demo", id: "Mixed", reasoning: true },
        { provider: "demo", id: "DEMO/Mixed", reasoning: false },
        { provider: "demo", id: "team/Reader", reasoning: true, thinkingLevelMap },
      ];
      const catalogResolver = createThinkingCatalogResolver(catalog);
      for (const source of [{ catalog }, { catalogResolver }]) {
        const params = { provider, model, ...source };
        expect(resolveThinkingProfile(params).levels.map(({ id }) => id)).toEqual(expected);
        expect(resolveThinkingDefaultForModel(params)).toBe(defaultLevel);
      }
    },
  );
});

describe("provider profiles", () => {
  it("retains medium defaults for Qwen chat-template models that declare efforts", () => {
    mocks.profile.mockReturnValue(undefined);
    const declaredCompat = {
      thinkingFormat: "qwen-chat-template",
      supportedReasoningEfforts: ["low", "medium", "xhigh"],
    };
    const catalog = [
      { provider: "local-qwen", id: "qwen-template", reasoning: true, compat: declaredCompat },
      {
        provider: "local-qwen",
        id: "qwen-template-no-high",
        reasoning: true,
        compat: declaredCompat,
        thinkingLevelMap: { high: null },
      },
      {
        provider: "local-qwen",
        id: "qwen-template-undeclared",
        reasoning: true,
        compat: { thinkingFormat: "qwen-chat-template" },
      },
      { provider: "local-qwen", id: "generic", reasoning: true },
    ];
    const resolveDefault = (model: string) =>
      resolveThinkingDefaultForModel({ provider: "local-qwen", model, catalog });

    expect(resolveDefault("qwen-template")).toBe("medium");
    expect(resolveDefault("qwen-template-no-high")).toBe("medium");
    expect(resolveDefault("qwen-template-undeclared")).toBe("medium");
    expect(resolveDefault("generic")).toBe("medium");
  });

  it("uses base levels without a provider", () => {
    expect(listThinkingLevels()).toEqual(baseLevels);
  });

  it("clamps from active provider facts without public artifact fallback", () => {
    expect(
      resolveSupportedThinkingLevel({
        ...thinkingModel(),
        level: "medium",
        providerPolicySource: "active",
      }),
    ).toBe("medium");
    expect(mocks.profile).toHaveBeenCalledWith(expect.objectContaining({ provider: "demo" }), {
      allowPublicArtifactFallback: false,
    });
  });

  it.each([undefined] as const)(
    "preserves binary labels and default %s from catalog context",
    (defaultLevel) => {
      mocks.profile.mockImplementation(({ context }) =>
        context.reasoning && context.compat?.thinkingFormat === "qwen-chat-template"
          ? { levels: [{ id: "off" }, { id: "low", label: "on" }], defaultLevel }
          : undefined,
      );
      const params = {
        provider: "vllm",
        model: "Qwen/Qwen3-8B",
        catalog: [
          {
            provider: "vllm",
            id: "vllm/Qwen/Qwen3-8B",
            reasoning: true,
            thinkingLevelMap: { xhigh: "xhigh", max: "max" },
            compat: { thinkingFormat: "qwen-chat-template", supportedReasoningEfforts: ["xhigh"] },
          },
        ],
      };
      expect(listThinkingLevelLabels(params.provider, params.model, params.catalog)).toEqual([
        "off",
        "on",
      ]);
      expect(formatThinkingLevels(params.provider, params.model, ", ", params.catalog)).toBe(
        "off, on",
      );
      expect(resolveThinkingDefaultForModel(params)).toBe(defaultLevel ?? "low");
      expect(resolveSupportedThinkingLevel({ ...params, level: "adaptive" })).toBe("low");
    },
  );

  it("keeps a configured catalog opt-out authoritative over runtime reasoning", () => {
    mocks.profile.mockReturnValue({ levels: [{ id: "off" }, { id: "low" }] });
    const params = thinkingModel({ reasoning: false, configuredReasoning: false });
    params.catalog.push({ provider: "demo-cli", id: "demo-model", reasoning: true });
    expect(listThinkingLevels(params.provider, params.model, params.catalog, "demo-cli")).toEqual([
      "off",
    ]);
  });

  it("composes discovered reasoning for a sparse configured row, end to end (#203150)", () => {
    mocks.profile.mockReturnValue({
      levels: [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }],
    });
    // Discovery reports the native thinking tier for gpt-6.2-sol, a model the
    // manifest catalog does not cover; the configured row only pins sizing.
    const discovered: ModelCatalogEntry = {
      provider: "openai",
      id: "gpt-6.2-sol",
      name: "GPT-6.2 Sol",
      reasoning: true,
    };
    const compose = (row: { id: string; contextTokens?: number; reasoning?: boolean }) => {
      const materialized = expectDefined(
        applyModelDefaults(
          {
            models: {
              providers: {
                openai: { baseUrl: "https://api.openai.com/v1", models: [row as never] },
              },
            },
          },
          // No manifest row covers gpt-6.2-sol: the omission must survive
          // materialization instead of being synthesized into `reasoning: false`.
          { manifestRegistry: { plugins: [] } },
        ).models?.providers?.openai?.models?.[0],
        "materialized model entry",
      );
      const configured = configuredModelCatalogEntry({
        provider: "openai",
        id: "gpt-6.2-sol",
        model: materialized,
        providerConfig: { baseUrl: "https://api.openai.com/v1", models: [materialized] },
        accepted: discovered,
      });
      // Prepared catalogs overlay configured fields over discovery facts, so
      // only an authored `reasoning` can hide what discovery reports.
      const composed = overlayCatalogMetadata(discovered, configured);
      return {
        materialized,
        configured,
        composed,
        levels: listThinkingLevels("openai", "gpt-6.2-sol", [composed], "demo-cli"),
      };
    };

    // Sparse row: omission survives materialization, discovery supplies the
    // native efforts, sizing is retained.
    const sparse = compose({ id: "gpt-6.2-sol", contextTokens: 500_000 });
    expect(sparse.materialized.reasoning).toBeUndefined();
    expect(sparse.materialized.contextTokens).toBe(500_000);
    expect(sparse.configured.configuredReasoning).toBeUndefined();
    expect(sparse.composed.reasoning).toBe(true);
    expect(sparse.composed.configuredReasoning).toBeUndefined();
    expect(sparse.composed.contextTokens).toBe(500_000);
    expect(sparse.levels).toEqual(["off", "low", "medium", "high"]);

    // Explicit opt-out stays authoritative over discovery.
    const optedOut = compose({ id: "gpt-6.2-sol", contextTokens: 500_000, reasoning: false });
    expect(optedOut.materialized.reasoning).toBe(false);
    expect(optedOut.composed.reasoning).toBe(false);
    expect(optedOut.composed.configuredReasoning).toBe(false);
    expect(optedOut.levels).toEqual(["off"]);

    // Explicit opt-in is retained.
    const optedIn = compose({ id: "gpt-6.2-sol", reasoning: true });
    expect(optedIn.materialized.reasoning).toBe(true);
    expect(optedIn.composed.reasoning).toBe(true);
    expect(optedIn.composed.configuredReasoning).toBe(true);
    expect(optedIn.levels).toEqual(["off", "low", "medium", "high"]);
  });

  it("preserves known-empty efforts while offering only host Ultra", () => {
    mocks.profile.mockReturnValue({ levels: [], defaultLevel: null });
    const params = {
      ...thinkingModel({
        api: "anthropic-messages",
        reasoning: true,
        thinkingLevelMap: { xhigh: "xhigh", max: "max" },
        compat: { supportedReasoningEfforts: ["adaptive", "xhigh", "max", "ultra"] },
      }),
      agentRuntime: "openclaw",
    };
    expect(resolveThinkingProfile(params)).toEqual({
      levels: [{ id: "ultra", label: "ultra", rank: 80 }],
      defaultLevel: undefined,
    });
    expect(resolveThinkingDefaultForModel(params)).toBe("off");
    expect(isThinkingLevelSupported({ ...params, level: "off" })).toBe(false);
    expect(isThinkingLevelSupported({ ...params, level: "high" })).toBe(false);
    expect(resolveProviderThinkingLevel({ ...params, level: "ultra" })).toBeUndefined();
    expect(listThinkingLevels(params.provider, params.model, params.catalog, "codex")).toEqual([]);
  });

  it.each([
    { agentRuntime: "openclaw", maxCap: undefined, expected: true },
    { agentRuntime: "auto", maxCap: null, expected: false },
  ])(
    "projects mapped Max for $agentRuntime with cap=$maxCap",
    ({ agentRuntime, maxCap, expected }) => {
      mocks.profile.mockReturnValue({ levels: [{ id: "off" }, { id: "high" }] });
      const params = thinkingModel({
        api: "openai-completions",
        reasoning: true,
        thinkingLevelMap: maxCap === null ? { max: null } : undefined,
        compat: {
          supportedReasoningEfforts: ["ProviderLow", "ProviderHigh"],
          reasoningEffortMap: { high: "ProviderLow", MAX: "ProviderHigh" },
        },
      });
      expect(
        listThinkingLevels(params.provider, params.model, params.catalog, agentRuntime).includes(
          "max",
        ),
      ).toBe(expected);
    },
  );

  it("honors thinking maps before advanced catalog efforts", () => {
    const params = thinkingModel({
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
    expect(listThinkingLevels(params.provider, params.model, params.catalog, "openclaw")).toEqual([
      "off",
      "high",
      "max",
      "ultra",
    ]);
    expect(resolveThinkingDefaultForModel(params)).toBe("high");
  });

  it("lets a row with a default thinking level own the profile over the provider hook", () => {
    mocks.profile.mockReturnValue({ levels: [{ id: "low" }], defaultLevel: "low" });
    const params = thinkingModel({
      reasoning: false,
      thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, xhigh: "max" },
      compat: {
        defaultThinkingLevel: "high",
        adaptiveThinking: true,
        thinkingRequired: true,
        thinkingLevelLabels: { low: "light" },
      },
    });
    expect(resolveThinkingProfile({ ...params, agentRuntime: "openclaw" })).toEqual({
      levels: [
        { id: "low", label: "light", rank: expect.any(Number) },
        { id: "adaptive", label: "adaptive", rank: expect.any(Number) },
        { id: "high", label: "high", rank: expect.any(Number) },
        { id: "xhigh", label: "xhigh", rank: expect.any(Number) },
        { id: "ultra", label: "ultra", rank: expect.any(Number) },
      ],
      defaultLevel: "high",
    });
    expect(mocks.profile).not.toHaveBeenCalled();
  });

  it("keeps a row without a default thinking level on the provider hook", () => {
    mocks.profile.mockReturnValue({ levels: [{ id: "low", label: "on" }], defaultLevel: "low" });
    const params = thinkingModel({ reasoning: true, compat: { adaptiveThinking: true } });
    expect(listThinkingLevels(params.provider, params.model, params.catalog, "codex")).toEqual([
      "low",
      "ultra",
    ]);
  });

  it("lets a stated ladder own the profile without a default", () => {
    mocks.profile.mockReturnValue({ levels: [{ id: "high" }], defaultLevel: "high" });
    // A mapped wire alias (xhigh -> high) stays hidden on the OpenClaw runtime too.
    const params = thinkingModel({
      api: "openai-responses",
      reasoning: true,
      compat: { thinkingLevels: ["low", "medium", "high"], reasoningEffortMap: { xhigh: "high" } },
    });
    expect(resolveThinkingProfile({ ...params, agentRuntime: "openclaw" })).toMatchObject({
      levels: [{ id: "low" }, { id: "medium" }, { id: "high" }, { id: "ultra" }],
      defaultLevel: undefined,
    });
    expect(resolveProviderThinkingLevel({ ...params, level: "ultra" })).toBe("high");
    expect(mocks.profile).not.toHaveBeenCalled();
  });

  it("preserves catalog-advertised advanced levels on other runtimes", () => {
    const params = thinkingModel({
      reasoning: true,
      compat: { supportedReasoningEfforts: ["low", "high", "xhigh", "max", "ultra"] },
    });
    expect(listThinkingLevels(params.provider, params.model, params.catalog, "codex")).toEqual([
      ...baseLevels,
      "xhigh",
      "max",
      "ultra",
    ]);
  });

  it("uses canonical Claude params without a provider profile", () => {
    const params = thinkingModel({
      api: "anthropic-messages",
      reasoning: false,
      params: { canonicalModelId: "claude-fable-5" },
    });
    expect(resolveThinkingProfile(params).levels.map(({ id }) => id)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(resolveThinkingDefaultForModel(params)).toBe("medium");
    expect(resolveSupportedThinkingLevel({ ...params, level: "adaptive" })).toBe("medium");
  });

  it.each<{
    levels: ThinkLevel[];
    defaultLevel?: ThinkLevel;
    requested: ThinkLevel;
    expected: ThinkLevel;
  }>([{ levels: ["low", "medium", "high"], requested: "off", expected: "low" }])(
    "clamps $requested to $expected with default $defaultLevel",
    ({ levels, defaultLevel, requested, expected }) => {
      mocks.profile.mockReturnValue({ levels: levels.map((id) => ({ id })), defaultLevel });
      expect(resolveSupportedThinkingLevel({ ...thinkingModel(), level: requested })).toBe(
        expected,
      );
    },
  );

  it("preserves provider ids and labels in options", () => {
    mocks.profile.mockReturnValue({
      levels: [{ id: "off" }, { id: "adaptive", label: "auto" }, { id: "max", label: "maximum" }],
      defaultLevel: "adaptive",
    });
    expect(listThinkingLevelOptions("demo", "demo-model")).toEqual([
      { id: "off", label: "off" },
      { id: "adaptive", label: "auto" },
      { id: "max", label: "maximum" },
    ]);
    expect(resolveThinkingDefaultForModel(thinkingModel())).toBe("adaptive");
  });
});

describe("Ultra provider boundary", () => {
  it("lowers host Ultra to the strongest native effort without making Ultra the default", () => {
    mocks.profile.mockReturnValue({ levels: [{ id: "high" }, { id: "max" }] });
    const params = { ...thinkingModel({ reasoning: true }), agentRuntime: "openclaw" };
    expect(resolveThinkingSelectionForModel({ ...params, level: "ultra" })).toEqual({
      requestedLevel: "ultra",
      level: "ultra",
      supported: true,
    });
    expect(resolveProviderThinkingLevel({ ...params, level: "ultra" })).toBe("max");
    expect(resolveThinkingSelectionForModel(params).requestedLevel).not.toBe("ultra");
  });

  it("boosts nonreasoning models only in the host harness", () => {
    const params = { ...thinkingModel({ reasoning: false }), agentRuntime: "openclaw" };
    expect(resolveThinkingSelectionForModel({ ...params, level: "ultra" }).level).toBe("ultra");
    expect(resolveProviderThinkingLevel({ ...params, level: "ultra" })).toBe("off");
    expect(resolveThinkingSelectionForModel(params).requestedLevel).toBe("off");
    expect(listThinkingLevels(params.provider, params.model, params.catalog, "codex")).toEqual([
      "off",
    ]);
  });
});
