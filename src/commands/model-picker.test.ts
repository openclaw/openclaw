import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  applyModelAllowlist,
  applyModelFallbacksFromSelection,
  promptDefaultModel,
  promptModelAllowlist,
} from "./model-picker.js";
import { makePrompter } from "./setup/__tests__/test-utils.js";

const loadModelCatalog = vi.hoisted(() => vi.fn());
vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog,
}));

const ensureAuthProfileStore = vi.hoisted(() =>
  vi.fn(() => ({
    version: 1,
    profiles: {},
  })),
);
const listProfilesForProvider = vi.hoisted(() => vi.fn(() => []));
const upsertAuthProfile = vi.hoisted(() => vi.fn());
vi.mock("../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore,
  listProfilesForProvider,
  upsertAuthProfile,
}));

const resolveEnvApiKey = vi.hoisted(() => vi.fn(() => undefined));
const hasUsableCustomProviderApiKey = vi.hoisted(() => vi.fn(() => false));
vi.mock("../agents/model-auth.js", () => ({
  resolveEnvApiKey,
  hasUsableCustomProviderApiKey,
}));

const resolveProviderModelPickerEntries = vi.hoisted(() => vi.fn(() => []));
const resolveProviderPluginChoice = vi.hoisted(() => vi.fn());
const runProviderModelSelectedHook = vi.hoisted(() => vi.fn(async () => {}));
const resolvePluginProviders = vi.hoisted(() => vi.fn(() => []));
const runProviderPluginAuthMethod = vi.hoisted(() => vi.fn());
vi.mock("./model-picker.runtime.js", () => ({
  modelPickerRuntime: {
    resolveProviderModelPickerEntries,
    resolveProviderPluginChoice,
    runProviderModelSelectedHook,
    resolvePluginProviders,
    runProviderPluginAuthMethod,
  },
}));

const OPENROUTER_CATALOG = [
  {
    provider: "openrouter",
    id: "auto",
    name: "OpenRouter Auto",
  },
  {
    provider: "openrouter",
    id: "meta-llama/llama-3.3-70b:free",
    name: "Llama 3.3 70B",
  },
] as const;

function expectRouterModelFiltering(options: Array<{ value: string }>) {
  expect(options.some((opt) => opt.value === "openrouter/auto")).toBe(false);
  expect(options.some((opt) => opt.value === "openrouter/meta-llama/llama-3.3-70b:free")).toBe(
    true,
  );
}

function createSelectAllMultiselect() {
  return vi.fn(async (params) => params.options.map((option: { value: string }) => option.value));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("promptDefaultModel", () => {
  it("supports configuring vLLM during setup", async () => {
    loadModelCatalog.mockResolvedValue([
      {
        provider: "anthropic",
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
      },
    ]);
    resolveProviderModelPickerEntries.mockReturnValue([
      { value: "vllm", label: "vLLM (custom)", hint: "Enter vLLM URL + API key + model" },
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
              models: [
                {
                  id: "meta-llama/Meta-Llama-3-8B-Instruct",
                  name: "meta-llama/Meta-Llama-3-8B-Instruct",
                },
              ],
            },
          },
        },
      },
      defaultModel: "vllm/meta-llama/Meta-Llama-3-8B-Instruct",
    });

    const select = vi.fn(async (params) => {
      const vllm = params.options.find((opt: { value: string }) => opt.value === "vllm");
      return (vllm?.value ?? "") as never;
    });
    const prompter = makePrompter({ select });
    const config = { agents: { defaults: {} } } as OpenClawConfig;

    const result = await promptDefaultModel({
      config,
      prompter,
      allowKeep: false,
      includeManual: false,
      includeProviderPluginSetups: true,
      ignoreAllowlist: true,
      agentDir: "/tmp/openclaw-agent",
      runtime: {} as never,
    });

    expect(runProviderPluginAuthMethod).toHaveBeenCalledOnce();
    expect(result.model).toBe("vllm/meta-llama/Meta-Llama-3-8B-Instruct");
    expect(result.config?.models?.providers?.vllm).toMatchObject({
      baseUrl: "http://127.0.0.1:8000/v1",
      api: "openai-completions",
      apiKey: "VLLM_API_KEY", // pragma: allowlist secret
      models: [
        { id: "meta-llama/Meta-Llama-3-8B-Instruct", name: "meta-llama/Meta-Llama-3-8B-Instruct" },
      ],
    });
  });
});

describe("promptModelAllowlist", () => {
  it("filters to allowed keys when provided", async () => {
    loadModelCatalog.mockResolvedValue([
      {
        provider: "anthropic",
        id: "claude-opus-4-5",
        name: "Claude Opus 4.5",
      },
      {
        provider: "anthropic",
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
      },
      {
        provider: "openai",
        id: "gpt-5.2",
        name: "GPT-5.2",
      },
    ]);

    const multiselect = createSelectAllMultiselect();
    const prompter = makePrompter({ multiselect });
    const config = { agents: { defaults: {} } } as OpenClawConfig;

    await promptModelAllowlist({
      config,
      prompter,
      allowedKeys: ["anthropic/claude-opus-4-5"],
    });

    const options = multiselect.mock.calls[0]?.[0]?.options ?? [];
    expect(options.map((opt: { value: string }) => opt.value)).toEqual([
      "anthropic/claude-opus-4-5",
    ]);
  });
});

describe("router model filtering", () => {
  it("filters internal router models in both default and allowlist prompts", async () => {
    loadModelCatalog.mockResolvedValue(OPENROUTER_CATALOG);

    const select = vi.fn(async (params) => {
      const first = params.options[0];
      return first?.value ?? "";
    });
    const multiselect = createSelectAllMultiselect();
    const defaultPrompter = makePrompter({ select });
    const allowlistPrompter = makePrompter({ multiselect });
    const config = { agents: { defaults: {} } } as OpenClawConfig;

    await promptDefaultModel({
      config,
      prompter: defaultPrompter,
      allowKeep: false,
      includeManual: false,
      ignoreAllowlist: true,
    });
    await promptModelAllowlist({ config, prompter: allowlistPrompter });

    const defaultOptions = select.mock.calls[0]?.[0]?.options ?? [];
    expectRouterModelFiltering(defaultOptions);

    const allowlistCall = multiselect.mock.calls[0]?.[0];
    expectRouterModelFiltering(allowlistCall?.options as Array<{ value: string }>);
    expect(allowlistCall?.searchable).toBe(true);
    expect(runProviderPluginAuthMethod).not.toHaveBeenCalled();
  });
});

describe("applyModelAllowlist", () => {
  it("preserves existing entries for selected models", () => {
    const config = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.2": { alias: "gpt" },
            "anthropic/claude-opus-4-5": { alias: "opus" },
          },
        },
      },
    } as OpenClawConfig;

    const next = applyModelAllowlist(config, ["openai/gpt-5.2"]);
    expect(next.agents?.defaults?.models).toEqual({
      "openai/gpt-5.2": { alias: "gpt" },
    });
  });

  it("clears the allowlist when no models remain", () => {
    const config = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.2": { alias: "gpt" },
          },
        },
      },
    } as OpenClawConfig;

    const next = applyModelAllowlist(config, []);
    expect(next.agents?.defaults?.models).toBeUndefined();
  });
});

describe("applyModelFallbacksFromSelection", () => {
  it("sets fallbacks from selection when the primary is included", () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-5" },
        },
      },
    } as OpenClawConfig;

    const next = applyModelFallbacksFromSelection(config, [
      "anthropic/claude-opus-4-5",
      "anthropic/claude-sonnet-4-5",
    ]);
    expect(next.agents?.defaults?.model).toEqual({
      primary: "anthropic/claude-opus-4-5",
      fallbacks: ["anthropic/claude-sonnet-4-5"],
    });
  });

  it("keeps existing fallbacks when the primary is not selected", () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-5", fallbacks: ["openai/gpt-5.2"] },
        },
      },
    } as OpenClawConfig;

    const next = applyModelFallbacksFromSelection(config, ["openai/gpt-5.2"]);
    expect(next.agents?.defaults?.model).toEqual({
      primary: "anthropic/claude-opus-4-5",
      fallbacks: ["openai/gpt-5.2"],
    });
  });
});
