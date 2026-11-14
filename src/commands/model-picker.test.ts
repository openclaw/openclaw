import path from "node:path";
import type { NormalizedModelCatalogRow } from "@openclaw/model-catalog-core/model-catalog-types";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../agents/model-catalog.types.js";
import type { LoadPreparedModelCatalogParams } from "../agents/prepared-model-catalog.js";
import type { OpenClawConfig } from "../config/config.js";
import { applyModelAllowlist } from "../flows/model-picker-allowlist.js";
import {
  applyModelFallbacksFromSelection,
  promptDefaultModel,
  promptModelAllowlist,
} from "../flows/model-picker.js";
import { createEmptyPluginSetupRegistry } from "../plugins/setup-registry.test-support.js";
import type { WizardMultiSelectParams, WizardPrompter } from "../wizard/prompts.js";
import { makePrompter } from "./setup/__tests__/test-utils.js";
import { createTestModelDefinition } from "./test-runtime-config-helpers.js";

const loadModelCatalog = vi.hoisted(() => vi.fn());
const modelCatalogRouteVariants = vi.hoisted(() => ({
  value: undefined as readonly ModelCatalogEntry[] | undefined,
}));
vi.mock("../agents/prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  loadPreparedModelCatalogSnapshot: async (params: LoadPreparedModelCatalogParams) => {
    if (params.providerDiscoveryProviderIds) {
      return loadScopedModelCatalog(params);
    }
    const entries = await loadModelCatalog(params);
    return { entries, routeVariants: modelCatalogRouteVariants.value ?? entries };
  },
}));

const loadStaticManifestCatalogRowsForList = vi.hoisted(() =>
  vi.fn<() => readonly NormalizedModelCatalogRow[]>(() => []),
);
// mock-isolation: Each picker case supplies its own static provider catalog.
vi.mock("./models/list.manifest-catalog.js", () => ({ loadStaticManifestCatalogRowsForList }));

const loadScopedModelCatalog = vi.hoisted(() =>
  vi.fn<(params: LoadPreparedModelCatalogParams) => Promise<ModelCatalogSnapshot>>(),
);

vi.mock("../agents/auth-profiles.js", () => ({
  externalCliDiscoveryForProviderAuth: () => ({ mode: "scoped", allowKeychainPrompt: false }),
  ensureAuthProfileStore: vi.fn(() => ({ version: 1, profiles: {} })),
  listProfilesForProvider: vi.fn(() => []),
  upsertAuthProfile: vi.fn(),
}));

type AuthParams = { cfg?: OpenClawConfig; workspaceDir?: string; env?: NodeJS.ProcessEnv };
type ModelRef = { api?: string | null; baseUrl?: unknown };
type AuthRoute = {
  api: "openai-responses" | "openai-chatgpt-responses";
  baseUrl: string;
  authRequirement: "api-key" | "subscription";
  requestTransportOverrides: "none" | "present";
};
type AuthEvaluation = {
  availability: boolean | undefined;
  routeResolution: null;
  selectedAuthMode?: string;
  evidence?: "aws-sdk" | "provider-config";
};

const modelAuth = vi.hoisted(() => ({
  resolveEnvApiKey: () => ({ apiKey: "test-key", source: "test" }),
  hasUsableCustomProviderApiKey: () => false,
  createRuntimeProviderAuthLookup: () => ({
    envApiKey: { aliasMap: {}, candidateMap: {}, authEvidenceMap: {} },
    syntheticAuthProviderRefs: [],
  }),
  hasRuntimeAvailableProviderAuth({ provider, cfg }: AuthParams & { provider: string }) {
    const auth = cfg?.models?.providers?.[provider]?.auth;
    // Other providers always have the fixed env key above; custom/local fallbacks are unreachable.
    return provider !== "amazon-bedrock" || auth === undefined || auth === "aws-sdk";
  },
}));
// mock-isolation: Model selection uses synthetic auth evidence, never host credentials.
vi.mock("../agents/model-auth.js", () => modelAuth);

const providerAuthRoute = vi.hoisted(() => ({ value: undefined as AuthRoute | undefined }));
const providerAuthEvaluations = vi.hoisted(() => new Map<string, AuthEvaluation>());
const createProviderAuthChecker = vi.hoisted(() =>
  vi.fn((params: AuthParams) => {
    const checker = vi.fn(async (provider: string, ref?: ModelRef) => {
      const prepared = providerAuthEvaluations.get(provider);
      return prepared
        ? prepared.availability === true
        : modelAuth.hasRuntimeAvailableProviderAuth({ provider, ...params }) &&
            !(
              ref?.api === "openai-chatgpt-responses" && ref.baseUrl === "https://api.openai.com/v1"
            );
    });
    return Object.assign(checker, {
      evaluateModelAuth: vi.fn(async (provider: string, ref?: ModelRef) => {
        const prepared = providerAuthEvaluations.get(provider);
        if (prepared) {
          return prepared;
        }
        const availability = await checker(provider, ref);
        const selectedRoute = providerAuthRoute.value;
        return {
          availability,
          routeResolution: selectedRoute
            ? { kind: "routes" as const, routes: [selectedRoute] as const }
            : null,
          ...(selectedRoute ? { selectedRoute } : {}),
        };
      }),
    });
  }),
);
// mock-isolation: The fixture owns provider auth evaluation and selected-route evidence.
vi.mock("../agents/model-provider-auth.js", () => ({ createProviderAuthChecker }));
// mock-isolation: Resolve fixture provider owners without loading installed provider plugins.
vi.mock("../plugins/providers.js", () => ({
  resolveOwningPluginIdsForProviderRef: ({ provider }: { provider: string }) => {
    const id = provider.replace(/-plan$/, "");
    return id === "byteplus" || id === "volcengine" ? [id] : undefined;
  },
}));
const pickerRuntime = vi.hoisted(() => ({
  resolveProviderModelPickerEntries: vi.fn(() => []),
  resolveProviderPluginChoice: vi.fn(),
  runProviderModelSelectedHook: vi.fn(async () => {}),
  resolvePluginProviders: vi.fn(() => []),
  runProviderPluginAuthMethod: vi.fn(),
}));
// mock-isolation: Picker hooks are fixture-controlled and must not run real auth or plugin hooks.
vi.mock("../commands/model-picker.runtime.js", () => ({ modelPickerRuntime: pickerRuntime }));

async function promptDefaultPicker(
  params: Partial<Parameters<typeof promptDefaultModel>[0]> = {},
  select = vi.fn(async (prompt) => prompt.initialValue as never),
) {
  const result = await promptDefaultModel({
    allowKeep: false,
    config: agentConfig(),
    prompter: makePrompter({ select }),
    ...params,
  });
  return { result, select };
}

async function pickAllowlist(params: Partial<Parameters<typeof promptModelAllowlist>[0]> = {}) {
  const multiselect = vi.fn(async ({ options }) => options.map(({ value }: PickerOption) => value));
  const result = await promptModelAllowlist({
    config: agentConfig(),
    prompter: makePrompter({ multiselect }),
    ...params,
  });
  return { result, multiselect, values: optionValues(pickerOptions(multiselect)) };
}

function catalogModel(provider: string, id: string, name: string): ModelCatalogEntry {
  return { provider, id, name };
}

function setScopedCatalog(entries: ModelCatalogEntry[]) {
  loadScopedModelCatalog.mockResolvedValue({ entries, routeVariants: entries });
}

function agentConfig(
  defaults: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]> = {},
): OpenClawConfig {
  return { agents: { defaults } };
}

function nvidiaConfig(ids: string[]): OpenClawConfig {
  const nvidia = {
    api: "openai-completions" as const,
    baseUrl: "https://integrate.api.nvidia.com/v1",
    models: ids.map((id) =>
      createTestModelDefinition(id, { contextWindow: 128_000, maxTokens: 8192 }),
    ),
  };
  return { agents: { defaults: {} }, models: { providers: { nvidia } } };
}

function manifestTextRow(
  provider: string,
  id: string,
  name: string,
  status: NormalizedModelCatalogRow["status"] = "available",
): NormalizedModelCatalogRow {
  return {
    ...catalogModel(provider, id, name),
    ref: `${provider}/${id}`,
    mergeKey: `${provider}:${id}`,
    source: "manifest",
    input: ["text"],
    reasoning: false,
    status,
  };
}

type MockCallSource = { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } };

type PickerOption = Record<string, unknown> & { value: string };

function pickerOptions(source: MockCallSource, callIndex = 0) {
  const params = source.mock.calls[callIndex]?.[0];
  expect(params).toMatchObject({ options: expect.any(Array) });
  return (params as { options: PickerOption[] }).options;
}

function optionValues(options: PickerOption[]) {
  return options.map((option) => option.value);
}

function requireOption(options: PickerOption[], value: string) {
  return expectDefined(
    options.find((candidate) => candidate.value === value),
    `expected picker option: ${value}`,
  );
}

beforeEach(() => {
  delete process.env.OPENCLAW_LOCALE;
  // Route hints exercise source policy even when a prior local build left stale dist artifacts.
  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.resolve("extensions"));
  vi.clearAllMocks();
  modelCatalogRouteVariants.value = undefined;
  providerAuthRoute.value = undefined;
  providerAuthEvaluations.clear();
  cliBackendsTesting.setDepsForTest({
    resolveRuntimeCliBackends: () => [],
    resolvePluginSetupRegistry: () => createEmptyPluginSetupRegistry(),
  });
  loadStaticManifestCatalogRowsForList.mockReturnValue([]);
  setScopedCatalog([]);
  pickerRuntime.resolveProviderModelPickerEntries.mockReturnValue([]);
  pickerRuntime.resolvePluginProviders.mockReturnValue([]);
});

afterEach(() => {
  cliBackendsTesting.resetDepsForTest();
  vi.unstubAllEnvs();
});

it("uses selected ChatGPT capabilities regardless of physical row order", async () => {
  providerAuthRoute.value = {
    api: "openai-chatgpt-responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    authRequirement: "subscription",
    requestTransportOverrides: "none",
  };
  const platform: ModelCatalogEntry = {
    provider: "openai",
    id: "gpt-5.5",
    name: "Platform GPT-5.5",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    contextWindow: 1_000_000,
    reasoning: true,
    input: ["text", "image"],
  };
  const chatGPT: ModelCatalogEntry = {
    ...platform,
    name: "ChatGPT GPT-5.5",
    api: "openai-chatgpt-responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    contextWindow: 400_000,
    reasoning: false,
    input: ["text"],
  };
  loadModelCatalog.mockResolvedValue([platform]);
  modelCatalogRouteVariants.value = [platform, chatGPT];
  const { select } = await promptDefaultPicker();
  const option = requireOption(pickerOptions(select), "openai/gpt-5.5");
  expect(option.hint).toContain("ChatGPT GPT-5.5");
  expect(option.hint).toContain("ctx 400k");
  expect(option.hint).not.toContain("reasoning");
  expect(optionValues(pickerOptions(select))).toEqual(["__manual__", "openai/gpt-5.5"]);
});

it("shows AWS SDK models but hides unresolved non-OpenAI SecretRefs", async () => {
  providerAuthEvaluations.set("amazon-bedrock", {
    availability: true,
    routeResolution: null,
    selectedAuthMode: "aws-sdk",
    evidence: "aws-sdk",
  });
  providerAuthEvaluations.set("anthropic", {
    availability: undefined,
    routeResolution: null,
    selectedAuthMode: "api-key",
    evidence: "provider-config",
  });
  loadModelCatalog.mockResolvedValue([
    {
      ...catalogModel("amazon-bedrock", "us.anthropic.claude-sonnet-4-5", "Bedrock Claude"),
      api: "bedrock-converse-stream",
    },
    {
      ...catalogModel("anthropic", "claude-sonnet-4-6", "Anthropic Claude"),
      api: "anthropic-messages",
    },
  ]);
  const { select } = await promptDefaultPicker();
  expect(optionValues(pickerOptions(select))).toEqual([
    "__manual__",
    "amazon-bedrock/us.anthropic.claude-sonnet-4-5",
  ]);
});

it("keeps provider browsing cold and preserves literal labels through selection", async () => {
  pickerRuntime.resolvePluginProviders.mockReturnValue([
    { id: "nvidia", preserveLiteralProviderPrefix: true },
  ] as never);
  setScopedCatalog([
    catalogModel("nvidia", "nvidia/native", "Native"),
    catalogModel("nvidia", "vendor/model", "Vendor"),
  ]);
  loadStaticManifestCatalogRowsForList.mockReturnValue([
    manifestTextRow("nvidia", "old-model", "Old", "deprecated"),
  ]);
  const select = vi
    .fn()
    .mockImplementationOnce(async (params) => {
      expect(loadModelCatalog).not.toHaveBeenCalled();
      expect(loadScopedModelCatalog).not.toHaveBeenCalled();
      expect(params).toMatchObject({ searchable: false, initialValue: "__keep__" });
      expect(optionValues(params.options)).toEqual(["__keep__", "__manual__", "__browse__"]);
      expect(requireOption(params.options, "__keep__").label).toBe(
        "Keep current (nvidia/nvidia/native)",
      );
      return "__browse__";
    })
    .mockResolvedValueOnce("nvidia/native");
  const { result } = await promptDefaultPicker({
    config: agentConfig({ model: "nvidia/native" }),
    prompter: makePrompter({ select }),
    allowKeep: true,
    preferredProvider: "nvidia",
    browseCatalogOnDemand: true,
  });
  expect(result.model).toBe("nvidia/native");
  expect(loadModelCatalog).not.toHaveBeenCalled();
  const options = pickerOptions(select, 1);
  expect(optionValues(options)).toEqual([
    "__keep__",
    "__manual__",
    "nvidia/native",
    "nvidia/vendor/model",
  ]);
  expect(requireOption(options, "nvidia/native").label).toBe("nvidia/nvidia/native");
  expect(requireOption(options, "nvidia/vendor/model").label).toBe("nvidia/vendor/model");
});

it("keeps empty-default provider browsing off unrelated provider setup surfaces", async () => {
  setScopedCatalog([
    catalogModel("ollama", "minimax-m2.7:cloud", "MiniMax M2.7"),
    catalogModel("ollama", "gemma4", "Gemma 4"),
  ]);
  pickerRuntime.resolveProviderModelPickerEntries.mockReturnValue([
    { value: "provider-plugin:nvidia:api-key", label: "NVIDIA (custom)" },
  ] as never);
  cliBackendsTesting.setDepsForTest({
    resolvePluginSetupRegistry: () => {
      throw new Error("preferred-provider browsing must not load the full setup registry");
    },
  });
  const select = vi.fn().mockResolvedValueOnce("ollama/gemma4");
  const config = agentConfig();
  await promptDefaultPicker({
    config,
    prompter: makePrompter({ select }),
    allowKeep: true,
    includeProviderPluginSetups: true,
    preferredProvider: "ollama",
    browseCatalogOnDemand: true,
    agentDir: "/tmp/openclaw-agent",
    runtime: {} as never,
  });
  expect(pickerRuntime.resolvePluginProviders).toHaveBeenCalledWith(
    expect.objectContaining({ providerRefs: ["ollama"] }),
  );
  expect(pickerRuntime.resolveProviderModelPickerEntries).not.toHaveBeenCalled();
  expect(optionValues(pickerOptions(select, 0))).not.toContain("provider-plugin:nvidia:api-key");
});

it("seeds scoped choices with a fallback-only agent's inherited primary", async () => {
  const config = {
    agents: {
      defaults: { model: "openai/global-model", models: { "anthropic/outside-scope": {} } },
      entries: { ops: { model: { fallbacks: ["openai/backup-model"] } } },
    },
  } satisfies OpenClawConfig;
  const before = structuredClone(config);
  const allowedKeys = ["openai/global-model", "openai/backup-model"];
  const { result, multiselect } = await pickAllowlist({
    config,
    agentId: "ops",
    agentDir: "/tmp/ops-agent",
    allowedKeys,
    loadCatalog: false,
  });
  const prompt = multiselect.mock.calls[0]?.[0];
  expect(optionValues(prompt.options)).toEqual(allowedKeys);
  expect(prompt.initialValues).toEqual(allowedKeys);
  expect(result).toEqual({ models: allowedKeys, scopeKeys: allowedKeys });
  expect(config).toEqual(before);
});

it("preserves static OpenAI route facts for future model auth checks", async () => {
  loadStaticManifestCatalogRowsForList.mockReturnValue([
    {
      ...manifestTextRow("openai", "gpt-future", "GPT Future"),
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
    },
  ]);
  const { multiselect } = await pickAllowlist({ preferredProvider: "openai" });
  expect(loadModelCatalog).not.toHaveBeenCalled();
  const checker = createProviderAuthChecker.mock.results.at(-1)?.value;
  expect(checker).toHaveBeenCalledWith("openai", {
    modelId: "gpt-future",
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
  });
  expect(optionValues(pickerOptions(multiselect))).toEqual(["openai/gpt-future"]);
});

it("includes stale configured preferred provider models in the scoped cleanup", async () => {
  loadModelCatalog.mockResolvedValue([
    catalogModel("openrouter", "meta-llama/llama-3.3-70b:free", "Llama 3.3 70B"),
    catalogModel("openai", "gpt-5.5", "GPT-5.5"),
  ]);
  const activeModel = "openrouter/meta-llama/llama-3.3-70b:free";
  const staleModel = "openrouter/elephant-alpha";
  const multiselect = vi.fn(async (params: WizardMultiSelectParams) =>
    params.options.map((option) => option.value).filter((value) => value === activeModel),
  );
  const prompter = makePrompter({
    multiselect: multiselect as unknown as WizardPrompter["multiselect"],
  });
  const config = agentConfig({
    models: {
      [activeModel]: { alias: "llama" },
      [staleModel]: { alias: "elephant" },
      "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
    },
  });
  const modelsBefore = structuredClone(config.agents?.defaults?.models);
  const result = await promptModelAllowlist({
    config,
    prompter,
    preferredProvider: "openrouter",
  });
  const options = pickerOptions(multiselect);
  expect(optionValues(options)).toEqual([activeModel, staleModel]);
  expect(requireOption(options, staleModel).hint).toBe("configured (not in catalog)");
  expect(multiselect.mock.calls[0]?.[0]?.initialValues).toEqual([activeModel, staleModel]);
  expect(result).toEqual({ models: [activeModel], scopeKeys: [activeModel, staleModel] });
  // Unmigrated legacy map: its restriction carries into the explicit policy.
  const next = applyModelAllowlist(config, result.models ?? [], { scopeKeys: result.scopeKeys });
  expect(next.agents?.defaults?.models).toEqual(modelsBefore);
  expect(next.agents?.defaults?.modelPolicy?.allow).toEqual([
    "anthropic/claude-sonnet-4-6",
    activeModel,
  ]);
});

it.each([true, false])(
  "preserves configured NVIDIA models with live catalog available: %s",
  async (live) => {
    const deprecated = manifestTextRow("nvidia", "z-ai/glm5", "Bundled GLM5", "deprecated");
    if (live) {
      setScopedCatalog([
        catalogModel("nvidia", "nvidia/native", "Native"),
        catalogModel("nvidia", "z-ai/glm-5.1", "GLM 5.1"),
        catalogModel("nvidia", "z-ai/glm5", "Deprecated GLM5"),
      ]);
    }
    loadStaticManifestCatalogRowsForList.mockReturnValue(
      live
        ? [
            manifestTextRow("nvidia", "nvidia/native", "Bundled Native"),
            manifestTextRow("nvidia", "z-ai/glm-5.1", "Bundled GLM 5.1"),
            deprecated,
          ]
        : [deprecated],
    );
    const configured = live
      ? ["nvidia/native", "z-ai/glm5", "private/custom-nvidia"]
      : ["custom-nvidia-model", "z-ai/glm5"];
    const { result, values } = await pickAllowlist({
      config: nvidiaConfig(configured),
      preferredProvider: "nvidia",
      loadCatalog: true,
      providerScopedCatalog: true,
    });
    expect(values).toEqual(
      live
        ? ["nvidia/native", "nvidia/z-ai/glm-5.1", "nvidia/private/custom-nvidia"]
        : ["nvidia/custom-nvidia-model", "nvidia/z-ai/glm5"],
    );
    expect(result.scopeKeys).toEqual(values);
    if (!live) {
      expect(loadStaticManifestCatalogRowsForList).not.toHaveBeenCalled();
      expect(loadModelCatalog).not.toHaveBeenCalled();
    }
  },
);

it.each([
  {
    name: "kept wildcard",
    saved: ["a/x", "p/*"],
    picks: ["p/one", "p/two"],
    allow: ["a/x", "p/*"],
  },
  {
    name: "no new wildcard",
    saved: ["a/x", "p/one"],
    picks: ["p/one", "p/two"],
    allow: ["a/x", "p/one", "p/two"],
  },
  { name: "narrowed wildcard", saved: ["a/x", "p/*"], picks: ["p/one"], allow: ["a/x", "p/one"] },
])("writes the configure selection into an existing allowlist: $name", (testCase) => {
  const { saved, picks, allow } = testCase;
  const models = { "a/x": { alias: "X" } };
  const config: OpenClawConfig = {
    meta: { migrations: { modelPolicyAllowlist: true } },
    agents: { defaults: { models, modelPolicy: { allow: saved } } },
  };
  const next = applyModelAllowlist(config, picks, { scopeKeys: ["p/one", "p/two"] });
  expect(next.agents?.defaults?.modelPolicy?.allow).toEqual(allow);
  // The models map is metadata; picks are not mirrored into it.
  expect(next.agents?.defaults?.models).toEqual(models);
});

it("does not create an allowlist when none exists", () => {
  const config: OpenClawConfig = { meta: { migrations: { modelPolicyAllowlist: true } } };
  expect(applyModelAllowlist(config, ["p/one"], { scopeKeys: ["p/one", "p/two"] })).toBe(config);
});

it("offers fallback-only selection when no allowlist exists", async () => {
  setScopedCatalog([catalogModel("nvidia", "rec", "Recommended")]);
  const { multiselect } = await pickAllowlist({
    config: agentConfig({ models: { "nvidia/rec": { alias: "rec" } } }),
    preferredProvider: "nvidia",
    providerScopedCatalog: true,
    restrictsPicker: false,
  });
  const prompt = multiselect.mock.calls[0]?.[0];
  expect(prompt?.message).toBe("Fallback models (multi-select)");
  // Model metadata is not a fallback; only the primary and fallbacks are preselected.
  expect(prompt?.initialValues).toBeUndefined();
});

it("saves new fallback-only picks outside the primary's provider", () => {
  const config = agentConfig({ model: { primary: "openai/gpt-5.5" } });
  const next = applyModelFallbacksFromSelection(config, ["nvidia/kimi"], {
    scopeKeys: ["nvidia/kimi", "nvidia/rec"],
    fallbacksOnly: true,
  });
  expect(next.agents?.defaults?.model).toEqual({
    primary: "openai/gpt-5.5",
    fallbacks: ["nvidia/kimi"],
  });
});

it.each([
  { allow: ["openai/gpt-5.5", "nvidia/rec", "nvidia/kimi"], seeded: ["nvidia/rec", "nvidia/kimi"] },
  { allow: ["openai/gpt-5.5", "nvidia/*"], seeded: ["nvidia/rec", "nvidia/kimi", "nvidia/other"] },
])("seeds a configure re-run from the saved allowlist: $allow", async ({ allow, seeded }) => {
  setScopedCatalog([
    catalogModel("nvidia", "rec", "Recommended"),
    catalogModel("nvidia", "kimi", "Kimi"),
    catalogModel("nvidia", "other", "Other"),
  ]);
  const { multiselect } = await pickAllowlist({
    config: {
      meta: { migrations: { modelPolicyAllowlist: true } },
      agents: { defaults: { model: { primary: "openai/gpt-5.5" }, modelPolicy: { allow } } },
    },
    preferredProvider: "nvidia",
    providerScopedCatalog: true,
  });
  expect(multiselect.mock.calls[0]?.[0]?.initialValues).toEqual(seeded);
});

it.each([
  { restrictsPicker: true, initial: "openai/*, anthropic/claude-sonnet-4-6" },
  { restrictsPicker: false, initial: "anthropic/claude-sonnet-4-6" },
])("keeps saved entries in the no-catalog text prompt: $restrictsPicker", async (testCase) => {
  loadModelCatalog.mockResolvedValue([]);
  const text = vi.fn(async ({ initialValue }: { initialValue?: string }) => initialValue ?? "");
  const config: OpenClawConfig = {
    meta: { migrations: { modelPolicyAllowlist: true } },
    agents: {
      defaults: {
        model: { primary: "openai/gpt-5.5", fallbacks: ["anthropic/claude-sonnet-4-6"] },
        models: { "openai/gpt-6-astra": {} },
        modelPolicy: { allow: ["openai/*", "anthropic/claude-sonnet-4-6"] },
      },
    },
  };
  const result = await promptModelAllowlist({
    config,
    prompter: makePrompter({ text: text as unknown as WizardPrompter["text"] }),
    restrictsPicker: testCase.restrictsPicker,
  });
  expect(text.mock.calls[0]?.[0]?.initialValue).toBe(testCase.initial);
  if (testCase.restrictsPicker) {
    const next = applyModelAllowlist(config, result.models ?? []);
    expect(next.agents?.defaults?.modelPolicy?.allow).toEqual([
      "openai/*",
      "anthropic/claude-sonnet-4-6",
    ]);
  }
});
