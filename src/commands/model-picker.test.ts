import path from "node:path";
import type { NormalizedModelCatalogRow } from "@openclaw/model-catalog-core/model-catalog-types";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../agents/model-catalog.types.js";
import type { LoadPreparedModelCatalogParams } from "../agents/prepared-model-catalog.js";
import type { OpenClawConfig } from "../config/config.js";
import { stampConfigWriteMetadata } from "../config/io.meta.js";
import type { AgentModelConfig } from "../config/types.agents-shared.js";
import {
  applyModelAllowlist,
  applyModelFallbacksFromSelection,
  promptDefaultModel,
  promptModelAllowlist,
} from "../flows/model-picker.js";
import type { WizardMultiSelectParams, WizardPrompter } from "../wizard/prompts.js";
import { makePrompter } from "./setup/__tests__/test-utils.js";

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
vi.mock("./models/list.manifest-catalog.js", () => ({
  loadStaticManifestCatalogRowsForList,
}));

const loadScopedModelCatalog = vi.hoisted(() =>
  vi.fn<(params: LoadPreparedModelCatalogParams) => Promise<ModelCatalogSnapshot>>(async () => ({
    entries: [],
    routeVariants: [],
  })),
);

vi.mock("../agents/auth-profiles.js", () => ({
  externalCliDiscoveryForProviderAuth: () => ({ mode: "scoped", allowKeychainPrompt: false }),
  ensureAuthProfileStore: vi.fn(() => ({ version: 1, profiles: {} })),
  listProfilesForProvider: vi.fn(() => []),
  upsertAuthProfile: vi.fn(),
}));

const resolveEnvApiKey = vi.hoisted(() =>
  vi.fn<(_provider: string, _env?: NodeJS.ProcessEnv) => { apiKey: string; source: string } | null>(
    (_provider: string) => ({
      apiKey: "test-key",
      source: "test",
    }),
  ),
);
const hasUsableCustomProviderApiKey = vi.hoisted(() =>
  vi.fn<(_cfg?: OpenClawConfig, _provider?: string, _env?: NodeJS.ProcessEnv) => boolean>(
    () => false,
  ),
);
const hasRuntimeAvailableProviderAuth = vi.hoisted(() =>
  vi.fn(
    ({
      provider,
      cfg,
      env,
    }: {
      provider: string;
      cfg?: OpenClawConfig;
      workspaceDir?: string;
      env?: NodeJS.ProcessEnv;
    }) => {
      if (provider === "amazon-bedrock") {
        const auth = cfg?.models?.providers?.["amazon-bedrock"]?.auth;
        return auth === undefined || auth === "aws-sdk";
      }
      if (resolveEnvApiKey(provider, env)?.apiKey) {
        return true;
      }
      if (hasUsableCustomProviderApiKey(cfg, provider, env)) {
        return true;
      }
      const providerConfig = cfg?.models?.providers?.[provider];
      return Boolean(
        providerConfig?.baseUrl?.startsWith("http://127.0.0.1") &&
        providerConfig.api &&
        providerConfig.models?.length &&
        !providerConfig.apiKey,
      );
    },
  ),
);
const createRuntimeProviderAuthLookup = vi.hoisted(() =>
  vi.fn(() => ({
    envApiKey: {
      aliasMap: {},
      candidateMap: {},
      authEvidenceMap: {},
    },
    syntheticAuthProviderRefs: [],
  })),
);
vi.mock("../agents/model-auth.js", () => ({
  createRuntimeProviderAuthLookup,
  resolveEnvApiKey,
  hasUsableCustomProviderApiKey,
  hasRuntimeAvailableProviderAuth,
}));

const providerAuthRoute = vi.hoisted(() => ({
  value: undefined as
    | {
        api: "openai-responses" | "openai-chatgpt-responses";
        baseUrl: string;
        authRequirement: "api-key" | "subscription";
        requestTransportOverrides: "none" | "present";
      }
    | undefined,
}));
const providerAuthEvaluations = vi.hoisted(
  () =>
    new Map<
      string,
      {
        availability: boolean | undefined;
        routeResolution: null;
        selectedAuthMode?: string;
        evidence?: "aws-sdk" | "provider-config";
      }
    >(),
);
const createProviderAuthChecker = vi.hoisted(() =>
  vi.fn((params: { cfg?: OpenClawConfig; workspaceDir?: string; env?: NodeJS.ProcessEnv }) => {
    const checker = vi.fn(
      async (provider: string, ref?: { api?: string | null; baseUrl?: unknown }) => {
        const prepared = providerAuthEvaluations.get(provider);
        if (prepared) {
          return prepared.availability === true;
        }
        return (
          hasRuntimeAvailableProviderAuth({
            provider,
            cfg: params.cfg,
            workspaceDir: params.workspaceDir,
            env: params.env,
          }) &&
          !(ref?.api === "openai-chatgpt-responses" && ref.baseUrl === "https://api.openai.com/v1")
        );
      },
    );
    const evaluateModelAuth = vi.fn(
      async (provider: string, ref?: { api?: string | null; baseUrl?: unknown }) => {
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
      },
    );
    return Object.assign(checker, { evaluateModelAuth });
  }),
);
vi.mock("../agents/model-provider-auth.js", () => ({
  createProviderAuthChecker,
}));

const resolveOwningPluginIdsForProvider = vi.hoisted(() =>
  vi.fn(({ provider }: { provider: string }) => {
    if (provider === "byteplus" || provider === "byteplus-plan") {
      return ["byteplus"];
    }
    if (provider === "volcengine" || provider === "volcengine-plan") {
      return ["volcengine"];
    }
    return undefined;
  }),
);
vi.mock("../plugins/providers.js", () => ({
  resolveOwningPluginIdsForProviderRef: resolveOwningPluginIdsForProvider,
}));

const providerModelPickerContributionRuntime = vi.hoisted(() => ({
  resolve: vi.fn(() => []),
}));
const resolveProviderPluginChoice = vi.hoisted(() => vi.fn());
const runProviderModelSelectedHook = vi.hoisted(() => vi.fn(async () => {}));
const resolvePluginProviders = vi.hoisted(() => vi.fn(() => []));
const runProviderPluginAuthMethod = vi.hoisted(() => vi.fn());
vi.mock("../commands/model-picker.runtime.js", () => ({
  modelPickerRuntime: {
    resolveProviderModelPickerContributions: providerModelPickerContributionRuntime.resolve,
    resolveProviderPluginChoice,
    runProviderModelSelectedHook,
    resolvePluginProviders,
    runProviderPluginAuthMethod,
  },
}));

const DEFAULT_MODEL_KEY = `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`;

const OPENROUTER_CATALOG = [
  catalogModel("openrouter", "auto", "OpenRouter Auto"),
  catalogModel("openrouter", "meta-llama/llama-3.3-70b:free", "Llama 3.3 70B"),
] as const;

function expectRouterModelFiltering(options: Array<{ value: string }>) {
  const routerValues = options
    .map((option) => option.value)
    .filter((value) => value.startsWith("openrouter/"));
  expect(routerValues).toEqual(["openrouter/meta-llama/llama-3.3-70b:free"]);
}

function createSelectAllMultiselect() {
  return vi.fn(async (params) => params.options.map((option: { value: string }) => option.value));
}

function promptDefaultPicker(params: Parameters<typeof promptDefaultModel>[0]) {
  return promptDefaultModel({
    allowKeep: false,
    includeManual: false,
    ignoreAllowlist: true,
    ...params,
  });
}

function catalogModel(provider: string, id: string, name: string): ModelCatalogEntry {
  return { provider, id, name };
}

function providerCatalogSnapshot(entries: ModelCatalogEntry[]): ModelCatalogSnapshot {
  return { entries, routeVariants: entries };
}

function agentConfig(
  defaults: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]> = {},
): OpenClawConfig {
  return { agents: { defaults } };
}

function configuredTextModel(id: string, name: string) {
  return {
    id,
    name,
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  };
}

function nvidiaConfig(models: ReturnType<typeof configuredTextModel>[]): OpenClawConfig {
  return {
    agents: { defaults: {} },
    models: {
      providers: {
        nvidia: {
          api: "openai-completions",
          baseUrl: "https://integrate.api.nvidia.com/v1",
          models,
        },
      },
    },
  };
}

function manifestTextRow(
  provider: string,
  id: string,
  name: string,
  status: NormalizedModelCatalogRow["status"] = "available",
): NormalizedModelCatalogRow {
  return {
    provider,
    id,
    name,
    ref: `${provider}/${id}`,
    mergeKey: `${provider}:${id}`,
    source: "manifest",
    input: ["text"],
    reasoning: false,
    status,
  };
}

type MockCallSource = {
  mock: {
    calls: ReadonlyArray<ReadonlyArray<unknown>>;
  };
};

type PickerOption = Record<string, unknown> & {
  value: string;
};

const requireRecord = createRequireRecord("object", "expected-label");

function pickerParams(source: MockCallSource, callIndex = 0) {
  return requireRecord(source.mock.calls[callIndex]?.[0], "picker params");
}

function pickerOptions(source: MockCallSource, callIndex = 0) {
  const options = pickerParams(source, callIndex).options;
  expect(options, "picker options").toBeInstanceOf(Array);
  return options as PickerOption[];
}

function optionValues(options: PickerOption[]) {
  return options.map((option) => option.value);
}

function requireOption(options: PickerOption[], value: string) {
  const option = options.find((candidate) => candidate.value === value);
  if (!option) {
    throw new Error(`expected picker option: ${value}`);
  }
  return option;
}

beforeEach(() => {
  delete process.env.OPENCLAW_LOCALE;
  // Route hints exercise source policy even when a prior local build left stale dist artifacts.
  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.resolve("extensions"));
  vi.clearAllMocks();
  modelCatalogRouteVariants.value = undefined;
  providerAuthRoute.value = undefined;
  providerAuthEvaluations.clear();
  const cliBackends = [
    {
      id: "claude-cli",
      modelProvider: "anthropic",
      pluginId: "anthropic",
      config: { command: "claude" },
    },
    {
      id: "google-gemini-cli",
      modelProvider: "google",
      pluginId: "google",
      config: { command: "gemini" },
    },
  ];
  cliBackendsTesting.setDepsForTest({
    resolveRuntimeCliBackends: () => cliBackends,
    resolvePluginSetupRegistry: () => ({
      providers: [],
      cliBackends: cliBackends.map(({ pluginId, ...backend }) => ({ pluginId, backend })),
      configMigrations: [],
      autoEnableProbes: [],
      diagnostics: [],
    }),
  });
  loadStaticManifestCatalogRowsForList.mockReturnValue([]);
  loadScopedModelCatalog.mockResolvedValue(providerCatalogSnapshot([]));
  resolveEnvApiKey.mockImplementation((_provider: string) => ({
    apiKey: "test-key",
    source: "test",
  }));
  hasUsableCustomProviderApiKey.mockReturnValue(false);
  providerModelPickerContributionRuntime.resolve.mockReturnValue([]);
  resolvePluginProviders.mockReturnValue([]);
});

afterEach(() => {
  cliBackendsTesting.resetDepsForTest();
  vi.unstubAllEnvs();
});

describe("promptDefaultModel", () => {
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
    const select = vi.fn(async (params) => params.initialValue as never);

    await promptDefaultPicker({
      config: agentConfig(),
      prompter: makePrompter({ select }),
    });

    const option = requireOption(pickerOptions(select as MockCallSource), "openai/gpt-5.5");
    expect(option.hint).toContain("ChatGPT GPT-5.5");
    expect(option.hint).toContain("ctx 400k");
    expect(option.hint).not.toContain("reasoning");
    expect(optionValues(pickerOptions(select as MockCallSource))).toEqual(["openai/gpt-5.5"]);
  });

  it("hides unauthenticated catalog entries from default model choices", async () => {
    resolveEnvApiKey.mockReturnValue(null);
    loadModelCatalog.mockResolvedValue([
      { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet" },
      { provider: "openai", id: "gpt-5.5", name: "GPT-5.5" },
    ]);

    const select = vi.fn(async (params) => params.initialValue as never);

    await promptDefaultPicker({
      config: { agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } } },
      prompter: makePrompter({ select }),
    });

    const values = optionValues(pickerOptions(select as MockCallSource));
    expect(values).toEqual(["anthropic/claude-sonnet-4-6"]);
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
    const select = vi.fn(async (params) => params.initialValue as never);

    await promptDefaultPicker({
      config: agentConfig(),
      prompter: makePrompter({ select }),
    });

    expect(optionValues(pickerOptions(select as MockCallSource))).toEqual([
      "amazon-bedrock/us.anthropic.claude-sonnet-4-5",
    ]);
  });

  it("treats byteplus plan models as preferred-provider matches", async () => {
    loadModelCatalog.mockResolvedValue([
      catalogModel("openai", "gpt-5.5", "GPT-5.5"),
      catalogModel("byteplus-plan", "ark-code-latest", "Ark Coding Plan"),
    ]);

    const select = vi.fn(async (params) => params.initialValue as never);
    const config = agentConfig({ model: "openai/gpt-5.5" });

    const result = await promptDefaultPicker({
      config,
      prompter: makePrompter({ select }),
      allowKeep: true,
      preferredProvider: "byteplus",
    });

    expect(optionValues(pickerOptions(select))[1]).toBe("byteplus-plan/ark-code-latest");
    expect(result.model).toBe("byteplus-plan/ark-code-latest");
  });

  it("keeps provider browsing cold and preserves literal labels through selection", async () => {
    resolvePluginProviders.mockReturnValue([
      { id: "nvidia", preserveLiteralProviderPrefix: true },
    ] as never);
    loadScopedModelCatalog.mockResolvedValue(
      providerCatalogSnapshot([
        catalogModel("nvidia", "nvidia/native", "Native"),
        catalogModel("nvidia", "vendor/model", "Vendor"),
      ]),
    );
    loadStaticManifestCatalogRowsForList.mockReturnValue([
      manifestTextRow("nvidia", "old-model", "Old", "deprecated"),
    ]);
    const select = vi
      .fn()
      .mockImplementationOnce(async (params) => {
        expect(loadModelCatalog).not.toHaveBeenCalled();
        expect(loadScopedModelCatalog).not.toHaveBeenCalled();
        expect(params.searchable).toBe(false);
        expect(params.initialValue).toBe("__keep__");
        expect(optionValues(params.options)).toEqual(["__keep__", "__manual__", "__browse__"]);
        expect(requireOption(params.options, "__keep__").label).toBe(
          "Keep current (nvidia/nvidia/native)",
        );
        return "__browse__";
      })
      .mockResolvedValueOnce("nvidia/native");
    const result = await promptDefaultPicker({
      config: agentConfig({ model: "nvidia/native" }),
      prompter: makePrompter({ select }),
      allowKeep: true,
      includeManual: true,
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

  it("loads the full model catalog when browsing without a preferred provider", async () => {
    loadModelCatalog.mockResolvedValue([
      catalogModel("openai", "gpt-5.5", "GPT-5.5"),
      catalogModel("openai", "gpt-5.5-pro", "GPT-5.5 Pro"),
    ]);
    const select = vi
      .fn()
      .mockResolvedValueOnce("__browse__")
      .mockImplementationOnce(async (params) => {
        const option = params.options.find(
          (entry: { value: string }) => entry.value === "openai/gpt-5.5-pro",
        );
        return option?.value ?? params.initialValue;
      });
    const config = agentConfig({ model: "openai/gpt-5.5" });

    const result = await promptDefaultPicker({
      config,
      prompter: makePrompter({ select }),
      allowKeep: true,
      includeManual: true,
      browseCatalogOnDemand: true,
    });

    expect(result.model).toBe("openai/gpt-5.5-pro");
    expect(loadModelCatalog).toHaveBeenCalledOnce();
    expect(loadScopedModelCatalog).not.toHaveBeenCalled();
    expect(select).toHaveBeenCalledTimes(2);
    expect(select.mock.calls[1]?.[0]?.searchable).toBe(true);
  });

  it("keeps empty-default provider browsing off unrelated provider setup surfaces", async () => {
    loadScopedModelCatalog.mockResolvedValue(
      providerCatalogSnapshot([
        catalogModel("ollama", "minimax-m2.7:cloud", "MiniMax M2.7"),
        catalogModel("ollama", "gemma4", "Gemma 4"),
      ]),
    );
    providerModelPickerContributionRuntime.resolve.mockReturnValue([
      {
        option: {
          value: "provider-plugin:nvidia:api-key",
          label: "NVIDIA (custom)",
        },
      },
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
      includeManual: true,
      includeProviderPluginSetups: true,
      preferredProvider: "ollama",
      browseCatalogOnDemand: true,
      agentDir: "/tmp/openclaw-agent",
      runtime: {} as never,
    });

    expect(resolvePluginProviders).toHaveBeenCalledWith(
      expect.objectContaining({
        providerRefs: ["ollama"],
      }),
    );
    expect(providerModelPickerContributionRuntime.resolve).not.toHaveBeenCalled();
    expect(optionValues(pickerOptions(select as MockCallSource, 0))).not.toContain(
      "provider-plugin:nvidia:api-key",
    );
  });

  it("preselects the first live provider row when keep-current is disabled", async () => {
    loadScopedModelCatalog.mockResolvedValue(
      providerCatalogSnapshot([
        catalogModel("nvidia", "z-ai/glm-5.1", "GLM 5.1"),
        catalogModel("nvidia", "nvidia/native", "Native"),
      ]),
    );
    const select = vi.fn(async (params) => params.initialValue as never);
    const config = agentConfig({
      model: "nvidia/current",
    });

    const result = await promptDefaultPicker({
      config,
      prompter: makePrompter({ select }),
      preferredProvider: "nvidia",
      browseCatalogOnDemand: true,
    });

    expect(result.model).toBe("nvidia/z-ai/glm-5.1");
    expect(pickerParams(select as MockCallSource).initialValue).toBe("nvidia/z-ai/glm-5.1");
    expect(optionValues(pickerOptions(select as MockCallSource))).toEqual([
      "nvidia/z-ai/glm-5.1",
      "nvidia/native",
      "nvidia/current",
    ]);
    expect(requireOption(pickerOptions(select as MockCallSource), "nvidia/current").hint).toBe(
      "current (not in catalog)",
    );
  });

  it("supports configuring vLLM during setup", async () => {
    loadModelCatalog.mockResolvedValue([
      catalogModel("anthropic", "claude-sonnet-4-6", "Claude Sonnet 4.5"),
    ]);
    providerModelPickerContributionRuntime.resolve.mockReturnValue([
      {
        id: "provider:model-picker:vllm",
        kind: "provider",
        surface: "model-picker",
        option: { value: "vllm", label: "vLLM (custom)", hint: "Enter vLLM URL + API key + model" },
      },
    ] as never);
    resolvePluginProviders.mockReturnValue([{ id: "vllm" }] as never);
    resolveProviderPluginChoice.mockReturnValue({
      provider: { id: "vllm", label: "vLLM", auth: [] },
      method: { id: "custom", label: "vLLM", kind: "custom" },
    });
    runProviderPluginAuthMethod.mockResolvedValue({
      config: {
        models: {
          providers: {
            vllm: {
              baseUrl: "http://127.0.0.1:8000/v1",
              api: "openai-completions",
              apiKey: "VLLM_API_KEY",
              models: [{ id: "org/model", name: "org/model" }],
            },
          },
        },
      },
      defaultModel: "vllm/org/model",
    });

    const select = vi.fn(async (params) => {
      const vllm = params.options.find((opt: { value: string }) => opt.value === "vllm");
      return (vllm?.value ?? "") as never;
    });
    const config = agentConfig();

    const result = await promptDefaultPicker({
      config,
      prompter: makePrompter({ select }),
      includeProviderPluginSetups: true,
      agentDir: "/tmp/openclaw-agent",
      runtime: {} as never,
    });

    expect(runProviderPluginAuthMethod).toHaveBeenCalledOnce();
    expect(result.model).toBe("vllm/org/model");
    expect(result.config?.models?.providers?.vllm).toEqual({
      baseUrl: "http://127.0.0.1:8000/v1",
      api: "openai-completions",
      apiKey: "VLLM_API_KEY", // pragma: allowlist secret
      models: [{ id: "org/model", name: "org/model" }],
    });
  });

  it("keeps skip-auth model selection cold when catalog loading is disabled", async () => {
    const select = vi.fn(async (params) => params.initialValue as never);
    const config = agentConfig({ model: "openai/gpt-5.5" });

    const result = await promptDefaultPicker({
      config,
      prompter: makePrompter({ select }),
      allowKeep: true,
      includeManual: true,
      includeProviderPluginSetups: true,
      loadCatalog: false,
      agentDir: "/tmp/openclaw-agent",
      runtime: {} as never,
    });

    expect(result).toStrictEqual({});
    expect(loadModelCatalog).not.toHaveBeenCalled();
    expect(providerModelPickerContributionRuntime.resolve).not.toHaveBeenCalled();
    expect(optionValues(pickerOptions(select as MockCallSource))).toEqual([
      "__keep__",
      "__manual__",
      "openai/gpt-5.5",
    ]);
  });
});

describe("promptModelAllowlist", () => {
  it("seeds scoped choices with a fallback-only agent's inherited primary", async () => {
    const multiselect = createSelectAllMultiselect();
    const config = {
      agents: {
        defaults: {
          model: "openai/global-model",
          models: { "anthropic/outside-scope": {} },
        },
        entries: { ops: { model: { fallbacks: ["openai/backup-model"] } } },
      },
    } satisfies OpenClawConfig;
    const before = structuredClone(config);
    const allowedKeys = ["openai/global-model", "openai/backup-model"];

    const result = await promptModelAllowlist({
      config,
      prompter: makePrompter({ multiselect }),
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

    const multiselect = createSelectAllMultiselect();
    await promptModelAllowlist({
      config: { agents: { defaults: {} } },
      prompter: makePrompter({ multiselect }),
      preferredProvider: "openai",
    });

    expect(loadModelCatalog).not.toHaveBeenCalled();
    const checker = createProviderAuthChecker.mock.results.at(-1)?.value;
    expect(checker).toHaveBeenCalledWith("openai", {
      modelId: "gpt-future",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });
    expect(optionValues(pickerOptions(multiselect as MockCallSource))).toEqual([
      "openai/gpt-future",
    ]);
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

    const result = await promptModelAllowlist({
      config,
      prompter,
      preferredProvider: "openrouter",
    });

    const options = pickerOptions(multiselect as MockCallSource);
    expect(optionValues(options)).toEqual([activeModel, staleModel]);
    expect(requireOption(options, staleModel).hint).toBe("configured (not in catalog)");
    expect(multiselect.mock.calls[0]?.[0]?.initialValues).toEqual([activeModel, staleModel]);
    expect(result).toEqual({
      models: [activeModel],
      scopeKeys: [activeModel, staleModel],
    });

    const next = applyModelAllowlist(config, result.models ?? [], {
      scopeKeys: result.scopeKeys,
    });
    expect(next.agents?.defaults?.models).toEqual({
      [activeModel]: { alias: "llama" },
      [staleModel]: { alias: "elephant" },
      "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
    });
    expect(next.agents?.defaults?.modelPolicy?.allow).toEqual([
      "anthropic/claude-sonnet-4-6",
      activeModel,
    ]);
  });

  it("keeps custom configured rows after provider-scoped live rows", async () => {
    loadScopedModelCatalog.mockResolvedValue(
      providerCatalogSnapshot([
        catalogModel("nvidia", "nvidia/native", "Native"),
        catalogModel("nvidia", "z-ai/glm-5.1", "GLM 5.1"),
        catalogModel("nvidia", "z-ai/glm5", "Deprecated GLM5"),
      ]),
    );
    loadStaticManifestCatalogRowsForList.mockReturnValue([
      manifestTextRow("nvidia", "nvidia/native", "Bundled Native"),
      manifestTextRow("nvidia", "z-ai/glm-5.1", "Bundled GLM 5.1"),
      manifestTextRow("nvidia", "z-ai/glm5", "Bundled GLM5", "deprecated"),
    ]);

    const multiselect = createSelectAllMultiselect();
    const config = nvidiaConfig([
      configuredTextModel("nvidia/native", "Bundled Native"),
      configuredTextModel("z-ai/glm5", "Configured GLM5 fallback"),
      configuredTextModel("private/custom-nvidia", "Private NVIDIA model"),
    ]);

    const result = await promptModelAllowlist({
      config,
      prompter: makePrompter({ multiselect }),
      preferredProvider: "nvidia",
      loadCatalog: true,
      providerScopedCatalog: true,
    });

    const values = optionValues(pickerOptions(multiselect as MockCallSource));
    expect(values).toEqual([
      "nvidia/native",
      "nvidia/z-ai/glm-5.1",
      "nvidia/private/custom-nvidia",
    ]);
    expect(result.scopeKeys).toEqual(values);
  });

  it("uses configured provider rows when a provider-scoped live catalog is unavailable", async () => {
    loadStaticManifestCatalogRowsForList.mockReturnValue([
      manifestTextRow("nvidia", "z-ai/glm5", "Bundled GLM5", "deprecated"),
    ]);

    const multiselect = createSelectAllMultiselect();
    const config = nvidiaConfig([
      configuredTextModel("custom-nvidia-model", "Custom NVIDIA model"),
      configuredTextModel("z-ai/glm5", "Configured GLM5 fallback"),
    ]);

    const result = await promptModelAllowlist({
      config,
      prompter: makePrompter({ multiselect }),
      preferredProvider: "nvidia",
      loadCatalog: true,
      providerScopedCatalog: true,
    });

    const values = optionValues(pickerOptions(multiselect as MockCallSource));
    expect(values).toEqual(["nvidia/custom-nvidia-model", "nvidia/z-ai/glm5"]);
    expect(result.scopeKeys).toEqual(values);
    expect(loadStaticManifestCatalogRowsForList).not.toHaveBeenCalled();
    expect(loadModelCatalog).not.toHaveBeenCalled();
  });

  it("resolves bare fallback seeds against the primary model provider", async () => {
    loadModelCatalog.mockResolvedValue([
      catalogModel("anthropic", "claude-opus-4-6", "Claude Opus 4.5"),
      catalogModel("openai", "claude-sonnet-4-6", "Wrong provider"),
    ]);

    const multiselect = vi.fn(async (params) => params.initialValues ?? []);
    const config = agentConfig({
      model: {
        primary: "anthropic/claude-opus-4-6",
        fallbacks: ["claude-sonnet-4-6"],
      },
    });

    const result = await promptModelAllowlist({ config, prompter: makePrompter({ multiselect }) });
    const call = pickerParams(multiselect as MockCallSource);

    expect(optionValues(pickerOptions(multiselect as MockCallSource))).toContain(
      "anthropic/claude-sonnet-4-6",
    );
    expect(call.initialValues).toEqual([
      "anthropic/claude-opus-4-6",
      "anthropic/claude-sonnet-4-6",
    ]);
    expect(result.models).toEqual(["anthropic/claude-opus-4-6", "anthropic/claude-sonnet-4-6"]);
  });

  it.each([false, true])(
    "seeds the no-catalog prompt only for an existing allowlist (%s)",
    async (restricted) => {
      loadModelCatalog.mockResolvedValue([]);
      const text = vi.fn(async (params) => params.initialValue ?? "");
      const config = agentConfig({
        model: { primary: "openai/gpt-5.5", fallbacks: ["anthropic/claude-sonnet-4-6"] },
        ...(restricted ? { models: { "openai/gpt-5.5": { alias: "gpt" } } } : {}),
      });
      const result = await promptModelAllowlist({ config, prompter: makePrompter({ text }) });
      expect(pickerParams(text).initialValue).toBe(
        restricted ? "openai/gpt-5.5, anthropic/claude-sonnet-4-6" : "",
      );
      expect(result).toEqual(
        restricted ? { models: ["openai/gpt-5.5", "anthropic/claude-sonnet-4-6"] } : {},
      );
    },
  );

  it("uses configured provider-scoped seeds without loading the full catalog", async () => {
    const multiselect = vi.fn(async (params) => params.initialValues ?? []);
    const config = agentConfig({ model: "openai/gpt-5.5" });

    const result = await promptModelAllowlist({
      config,
      prompter: makePrompter({ multiselect }),
      preferredProvider: "openai",
      loadCatalog: false,
    });

    expect(loadModelCatalog).not.toHaveBeenCalled();
    expect(optionValues(pickerOptions(multiselect as MockCallSource))).toEqual(["openai/gpt-5.5"]);
    expect(pickerParams(multiselect as MockCallSource).initialValues).toEqual(["openai/gpt-5.5"]);
    expect(result).toEqual({
      models: ["openai/gpt-5.5"],
      scopeKeys: ["openai/gpt-5.5"],
    });
  });
});

describe("runtime model picker visibility", () => {
  it("hides legacy runtime refs from allowlist choices and configured supplements", async () => {
    loadModelCatalog.mockResolvedValue([
      { provider: "codex", id: "gpt-5.5", name: "GPT-5.5" },
      { provider: "claude-cli", id: "claude-sonnet-4-6", name: "Claude Sonnet" },
      { provider: "google-gemini-cli", id: "gemini-3-pro-preview", name: "Gemini 3 Pro" },
      { provider: "openai", id: "gpt-5.5", name: "GPT-5.5" },
      { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet" },
      { provider: "google", id: "gemini-3-pro-preview", name: "Gemini 3 Pro" },
    ]);

    const multiselect = createSelectAllMultiselect();
    const config = agentConfig({
      models: {
        "codex/gpt-5.5": { alias: "legacy-codex" },
        "claude-cli/claude-sonnet-4-6": { alias: "CLI Claude" },
        "google-gemini-cli/gemini-3-pro-preview": { alias: "CLI Gemini" },
        "openai/gpt-5.5": { alias: "gpt" },
      },
    });

    await promptModelAllowlist({ config, prompter: makePrompter({ multiselect }) });

    const call = pickerParams(multiselect as MockCallSource);
    const values = optionValues(call.options as PickerOption[]);
    expect(values).toEqual([
      "openai/gpt-5.5",
      "anthropic/claude-sonnet-4-6",
      "google/gemini-3.1-pro-preview",
      DEFAULT_MODEL_KEY,
    ]);
    expect(call.initialValues).toEqual(["openai/gpt-5.5", DEFAULT_MODEL_KEY]);
  });
});

describe("router model filtering", () => {
  it("filters internal router models in both default and allowlist prompts", async () => {
    loadModelCatalog.mockResolvedValue(OPENROUTER_CATALOG);

    const select = vi.fn(async (params) => params.options[0]?.value ?? "");
    const multiselect = createSelectAllMultiselect();
    const config = agentConfig();

    await promptDefaultPicker({
      config,
      prompter: makePrompter({ select }),
    });
    await promptModelAllowlist({ config, prompter: makePrompter({ multiselect }) });

    expectRouterModelFiltering(pickerOptions(select as MockCallSource));

    const allowlistCall = pickerParams(multiselect as MockCallSource);
    expectRouterModelFiltering(allowlistCall.options as Array<{ value: string }>);
    expect(allowlistCall.searchable).toBe(true);
    expect(runProviderPluginAuthMethod).not.toHaveBeenCalled();
  });
});

describe("applyModelAllowlist", () => {
  it("normalizes retired Google Gemini refs before writing selected models", () => {
    const config = agentConfig({
      models: {
        "google/gemini-3.1-pro-preview": { alias: "gemini" },
        "anthropic/claude-opus-4-6": { alias: "opus" },
      },
    });

    const next = applyModelAllowlist(config, [
      "google/gemini-3-pro-preview",
      "google-gemini-cli/gemini-3-pro-preview",
      "openrouter/google/gemini-3-pro-preview",
      "litellm/gemini-3-flash",
    ]);
    expect(next.agents?.defaults?.models).toEqual({
      "google/gemini-3.1-pro-preview": { alias: "gemini" },
      "anthropic/claude-opus-4-6": { alias: "opus" },
      "google-gemini-cli/gemini-3.1-pro-preview": {},
      "openrouter/google/gemini-3.1-pro-preview": {},
      "litellm/gemini-3-flash": {},
    });
    expect(next.agents?.defaults?.modelPolicy?.allow).toEqual([
      "google/gemini-3.1-pro-preview",
      "google-gemini-cli/gemini-3.1-pro-preview",
      "openrouter/google/gemini-3.1-pro-preview",
      "litellm/gemini-3-flash",
    ]);
  });

  it("preserves entries outside scoped allowlist updates", () => {
    const config = agentConfig({
      models: {
        "openai/gpt-5.5": { alias: "gpt" },
        "anthropic/claude-opus-4-6": { alias: "opus" },
        "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
      },
      modelPolicy: { allow: ["openai/*", "anthropic/*", "sonnet"] },
    });

    const next = applyModelAllowlist(config, ["anthropic/claude-sonnet-4-6"], {
      scopeKeys: ["anthropic/claude-opus-4-6", "anthropic/claude-sonnet-4-6"],
    });
    expect(next.agents?.defaults?.models).toEqual({
      "openai/gpt-5.5": { alias: "gpt" },
      "anthropic/claude-opus-4-6": { alias: "opus" },
      "anthropic/claude-sonnet-4-6": { alias: "sonnet" },
    });
    expect(next.agents?.defaults?.modelPolicy?.allow).toEqual([
      "openai/*",
      "anthropic/claude-sonnet-4-6",
    ]);
  });

  it("clears an effective legacy restriction and preserves model metadata", () => {
    const config = agentConfig({
      models: {
        "openai/gpt-5.5": { alias: "gpt" },
      },
    });

    const applied = applyModelAllowlist(config, []);
    const next = stampConfigWriteMetadata(applied, undefined, undefined, config);
    expect(next.agents?.defaults?.models).toEqual({
      "openai/gpt-5.5": { alias: "gpt" },
    });
    expect(next.agents?.defaults?.modelPolicy?.allow).toEqual([]);
    expect(next.meta?.migrations?.modelPolicyAllowlist).toBe(true);
  });
});

describe("applyModelFallbacksFromSelection", () => {
  const primary = "openai/gpt-5.5";
  const backup = "openai/gpt-5.4";
  const outside = "anthropic/claude-sonnet-4-6";
  const hidden = "claude-cli/claude-sonnet-4-6";
  const cases: Array<{
    name: string;
    model?: AgentModelConfig;
    selection: string[];
    scopeKeys?: string[];
    expected: AgentModelConfig;
  }> = [
    {
      name: "does not inject an unconfigured primary",
      selection: [DEFAULT_MODEL_KEY, outside],
      expected: { fallbacks: [outside] },
    },
    {
      name: "normalizes retired primary and fallback refs",
      model: {
        primary: "google/gemini-3-pro-preview",
        fallbacks: ["openrouter/google/gemini-3-pro-preview"],
      },
      selection: ["google/gemini-3.1-pro-preview", "openrouter/google/gemini-3-pro-preview"],
      expected: {
        primary: "google/gemini-3.1-pro-preview",
        fallbacks: ["openrouter/google/gemini-3.1-pro-preview"],
      },
    },
    {
      name: "drops malformed and deselected refs while preserving hidden fallbacks",
      model: { primary, fallbacks: ["openai/", hidden, outside] },
      selection: [primary],
      expected: { primary, fallbacks: [hidden] },
    },
    {
      name: "reconciles scoped aliases and preserves outside fallbacks",
      model: { primary, fallbacks: ["mini", backup, outside] },
      selection: [primary, "openai/gpt-5.4-mini"],
      scopeKeys: [primary, backup, "openai/gpt-5.4-mini"],
      expected: { primary, fallbacks: ["openai/gpt-5.4-mini", outside] },
    },
    {
      name: "clears an empty scope and normalizes remaining fallbacks",
      model: { primary: outside, fallbacks: [primary, "google/gemini-3-pro-preview"] },
      selection: [],
      scopeKeys: [primary, backup],
      expected: { primary: outside, fallbacks: ["google/gemini-3.1-pro-preview"] },
    },
    {
      name: "does not add scoped fallbacks without the primary",
      model: { primary: outside, fallbacks: [primary] },
      selection: [primary, backup],
      scopeKeys: [primary, backup],
      expected: { primary: outside, fallbacks: [primary] },
    },
    {
      name: "preserves unscoped fallbacks without the primary",
      model: { primary: outside, fallbacks: [primary] },
      selection: [primary],
      expected: { primary: outside, fallbacks: [primary] },
    },
  ];
  it.each(cases)("$name", ({ model, selection, scopeKeys, expected }) => {
    const config = agentConfig({
      ...(model === undefined ? {} : { model }),
      models: { "openai/gpt-5.4-mini": { alias: "mini" } },
    });
    const next = applyModelFallbacksFromSelection(config, selection, { scopeKeys });
    expect(next.agents?.defaults?.model).toEqual(expected);
  });
});

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

const agentCases: Array<{
  name: string;
  model?: AgentModelConfig;
  expected: string;
  choice: string;
}> = [
  {
    name: "fallback-only",
    model: { fallbacks: ["anthropic/backup-model"] },
    expected: "openai/global-model",
    choice: "__manual__",
  },
  {
    name: "explicit primary",
    model: "anthropic/ops-model",
    expected: "anthropic/ops-model",
    choice: "__keep__",
  },
  {
    name: "explicit primary manual choice",
    model: "anthropic/ops-model",
    expected: "anthropic/ops-model",
    choice: "__manual__",
  },
  { name: "inherited primary", expected: "openai/global-model", choice: "__keep__" },
];
it.each(agentCases)(
  "shows the effective $name without mutating config",
  async ({ model, expected, choice }) => {
    const config = {
      agents: {
        defaults: { model: "openai/global-model" },
        entries: { ops: { default: true, ...(model !== undefined ? { model } : {}) } },
      },
    } satisfies OpenClawConfig;
    const before = structuredClone(config);
    const text = vi.fn(async (params: { initialValue?: string }) => {
      expect(params.initialValue).toBe(expected);
      return expected;
    });
    const result = await promptDefaultModel({
      config,
      agentId: "ops",
      agentDir: "/tmp/ops-agent",
      workspaceDir: "/tmp/ops-workspace",
      loadCatalog: false,
      prompter: makePrompter({
        text,
        select: async ({ options }) => {
          expect(options.find((option) => option.value === "__keep__")?.label).toContain(expected);
          const selected = options.find((option) => option.value === choice);
          if (!selected) {
            throw new Error(`Missing picker option: ${choice}`);
          }
          return selected.value;
        },
      }),
    });
    expect(result).toEqual(choice === "__keep__" ? {} : { model: expected });
    expect(text).toHaveBeenCalledTimes(choice === "__manual__" ? 1 : 0);
    expect(config).toEqual(before);
  },
);
