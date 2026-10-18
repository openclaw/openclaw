import { beforeEach, expect, it, vi } from "vitest";
import type { ThinkingCatalogEntry } from "./thinking.shared.js";

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

beforeEach(() => mocks.profile.mockReset());
type ModelFacts = Omit<ThinkingCatalogEntry, "provider" | "id">;
function thinkingModel(
  entry: ModelFacts = {},
  provider = "demo",
  model = "demo-model",
  id = model,
) {
  return { provider, model, catalog: [{ provider, id, ...entry }] };
}
const baseLevels = ["off", "minimal", "low", "medium", "high"];
function levels(params: ReturnType<typeof thinkingModel>, runtime?: string) {
  return listThinkingLevels(params.provider, params.model, params.catalog, runtime);
}

it("normalizes streaming reasoning visibility", () => {
  expect(normalizeReasoningLevel("streaming")).toBe("stream");
});

it("preserves literal identity for demo/team/Reader", () => {
  const thinkingLevelMap = { off: null, minimal: null, low: null, medium: null };
  const catalog = [{ provider: "demo", id: "team/Reader", reasoning: true, thinkingLevelMap }];
  const catalogResolver = createThinkingCatalogResolver(catalog);
  for (const source of [{ catalog }, { catalogResolver }]) {
    const params = { provider: "demo/team", model: "Reader", ...source };
    expect(resolveThinkingProfile(params).levels.map(({ id }) => id)).toEqual(baseLevels);
    expect(resolveThinkingDefaultForModel(params)).toBe("off");
  }
});

const declaredCompat = {
  thinkingFormat: "qwen-chat-template",
  supportedReasoningEfforts: ["low", "medium", "xhigh"],
};
it.each<[string, ModelFacts]>([
  ["qwen-template", { compat: declaredCompat }],
  ["qwen-template-no-high", { compat: declaredCompat, thinkingLevelMap: { high: null } }],
  ["qwen-template-undeclared", { compat: { thinkingFormat: "qwen-chat-template" } }],
  ["generic", {}],
])("retains the medium default for %s", (model, facts) => {
  const params = thinkingModel({ reasoning: true, ...facts }, "local-qwen", model);
  expect(resolveThinkingDefaultForModel(params)).toBe("medium");
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

it("preserves binary labels and default from catalog context", () => {
  mocks.profile.mockImplementation(({ context }) =>
    context.reasoning && context.compat?.thinkingFormat === "qwen-chat-template"
      ? { levels: [{ id: "off" }, { id: "low", label: "on" }], defaultLevel: undefined }
      : undefined,
  );
  const params = thinkingModel(
    {
      reasoning: true,
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
      compat: { thinkingFormat: "qwen-chat-template", supportedReasoningEfforts: ["xhigh"] },
    },
    "vllm",
    "Qwen/Qwen3-8B",
    "vllm/Qwen/Qwen3-8B",
  );
  expect(listThinkingLevelLabels(params.provider, params.model, params.catalog)).toEqual([
    "off",
    "on",
  ]);
  expect(formatThinkingLevels(params.provider, params.model, ", ", params.catalog)).toBe("off, on");
  expect(resolveThinkingDefaultForModel(params)).toBe("low");
  expect(resolveSupportedThinkingLevel({ ...params, level: "adaptive" })).toBe("low");
});

it("keeps a configured catalog opt-out authoritative over runtime reasoning", () => {
  mocks.profile.mockReturnValue({ levels: [{ id: "off" }, { id: "low" }] });
  const params = thinkingModel({ reasoning: false, configuredReasoning: false });
  params.catalog.push({ provider: "demo-cli", id: "demo-model", reasoning: true });
  expect(levels(params, "demo-cli")).toEqual(["off"]);
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
  expect(levels(params, "codex")).toEqual([]);
});

it.each([
  ["openclaw", undefined, true],
  ["auto", null, false],
] as const)("projects mapped Max for %s with cap=%s", (runtime, cap, expected) => {
  mocks.profile.mockReturnValue({ levels: [{ id: "off" }, { id: "high" }] });
  const params = thinkingModel({
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: cap === null ? { max: null } : undefined,
    compat: {
      supportedReasoningEfforts: ["ProviderLow", "ProviderHigh"],
      reasoningEffortMap: { high: "ProviderLow", MAX: "ProviderHigh" },
    },
  });
  expect(levels(params, runtime).includes("max")).toBe(expected);
});

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
  expect(levels(params, "openclaw")).toEqual(["off", "high", "max", "ultra"]);
  expect(resolveThinkingDefaultForModel(params)).toBe("high");
});

it("preserves catalog-advertised advanced levels on other runtimes", () => {
  const params = thinkingModel({
    reasoning: true,
    compat: { supportedReasoningEfforts: ["low", "high", "xhigh", "max", "ultra"] },
  });
  expect(levels(params, "codex")).toEqual([...baseLevels, "xhigh", "max", "ultra"]);
});

it("uses canonical Claude params without a provider profile", () => {
  const params = thinkingModel({
    api: "anthropic-messages",
    reasoning: false,
    params: { canonicalModelId: "claude-fable-5" },
  });
  expect(levels(params)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  expect(resolveThinkingDefaultForModel(params)).toBe("medium");
  expect(resolveSupportedThinkingLevel({ ...params, level: "adaptive" })).toBe("medium");
});

it("clamps off to the lowest supported effort without a default", () => {
  mocks.profile.mockReturnValue({ levels: [{ id: "low" }, { id: "medium" }, { id: "high" }] });
  expect(resolveSupportedThinkingLevel({ ...thinkingModel(), level: "off" })).toBe("low");
});

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
  expect(levels(params, "codex")).toEqual(["off"]);
});
