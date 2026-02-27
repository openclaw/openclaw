import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  applyModelAllowlist,
  applyModelFallbacksFromSelection,
  promptDefaultModel,
  promptModelAllowlist,
} from "./model-picker.js";
import { makePrompter } from "./onboarding/__tests__/test-utils.js";

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
const listProfilesForProvider = vi.hoisted(() =>
  vi.fn((_store: unknown, _provider: string) => [] as string[]),
);
const upsertAuthProfile = vi.hoisted(() => vi.fn());
const upsertAuthProfileWithLock = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore,
  listProfilesForProvider,
  upsertAuthProfile,
  upsertAuthProfileWithLock,
}));

const resolveEnvApiKey = vi.hoisted(() => vi.fn(() => undefined));
const getCustomProviderApiKey = vi.hoisted(() => vi.fn(() => undefined));
vi.mock("../agents/model-auth.js", () => ({
  resolveEnvApiKey,
  getCustomProviderApiKey,
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

describe("promptDefaultModel", () => {
  it("supports configuring vLLM during onboarding", async () => {
    loadModelCatalog.mockResolvedValue([
      {
        provider: "anthropic",
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
      },
    ]);

    const select = vi.fn(async (params) => {
      const vllm = params.options.find((opt: { value: string }) => opt.value === "__vllm__");
      return (vllm?.value ?? "") as never;
    });
    const text = vi
      .fn()
      .mockResolvedValueOnce("http://127.0.0.1:8000/v1")
      .mockResolvedValueOnce("sk-vllm-test")
      .mockResolvedValueOnce("meta-llama/Meta-Llama-3-8B-Instruct");
    const prompter = makePrompter({ select, text: text as never });
    const config = { agents: { defaults: {} } } as OpenClawConfig;

    const result = await promptDefaultModel({
      config,
      prompter,
      allowKeep: false,
      includeManual: false,
      includeVllm: true,
      ignoreAllowlist: true,
      agentDir: "/tmp/openclaw-agent",
    });

    expect(upsertAuthProfileWithLock).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: "vllm:default",
        credential: expect.objectContaining({ provider: "vllm" }),
      }),
    );
    expect(result.model).toBe("vllm/meta-llama/Meta-Llama-3-8B-Instruct");
    expect(result.config?.models?.providers?.vllm).toMatchObject({
      baseUrl: "http://127.0.0.1:8000/v1",
      api: "openai-completions",
      apiKey: "VLLM_API_KEY",
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

describe("promptDefaultModel auth filtering", () => {
  it("filters models to only show providers with auth when no allowlist is configured", async () => {
    // Mock catalog with models from multiple providers
    loadModelCatalog.mockResolvedValue([
      {
        provider: "anthropic",
        id: "claude-opus-4-5",
        name: "Claude Opus 4.5",
      },
      {
        provider: "openai",
        id: "gpt-5.2",
        name: "GPT-5.2",
      },
      {
        provider: "google",
        id: "gemini-2.0",
        name: "Gemini 2.0",
      },
    ]);

    // Mock auth: only anthropic has profiles
    listProfilesForProvider.mockImplementation((_store: unknown, provider: string) => {
      return provider === "anthropic" ? ["anthropic:default"] : [];
    });
    resolveEnvApiKey.mockReturnValue(undefined);
    getCustomProviderApiKey.mockReturnValue(undefined);

    const select = vi.fn(async (params) => {
      return params.options[0]?.value ?? "";
    });
    const prompter = makePrompter({ select });

    // Config with no allowlist configured
    const config = { agents: { defaults: {} } } as OpenClawConfig;

    await promptDefaultModel({
      config,
      prompter,
      allowKeep: false,
      includeManual: false,
      agentDir: "/tmp/test-agent",
      // ignoreAllowlist defaults to false
    });

    const options = select.mock.calls[0]?.[0]?.options ?? [];
    const modelValues = options.map((opt: { value: string }) => opt.value);

    // Should only show anthropic models since that's the only provider with auth
    expect(modelValues).toContain("anthropic/claude-opus-4-5");
    expect(modelValues).not.toContain("openai/gpt-5.2");
    expect(modelValues).not.toContain("google/gemini-2.0");
  });

  it("shows all models from allowed providers when allowlist is configured", async () => {
    loadModelCatalog.mockResolvedValue([
      {
        provider: "anthropic",
        id: "claude-opus-4-5",
        name: "Claude Opus 4.5",
      },
      {
        provider: "openai",
        id: "gpt-5.2",
        name: "GPT-5.2",
      },
    ]);

    const select = vi.fn(async (params) => {
      return params.options[0]?.value ?? "";
    });
    const prompter = makePrompter({ select });

    // Config with allowlist
    const config = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-opus-4-5": {},
            "openai/gpt-5.2": {},
          },
        },
      },
    } as OpenClawConfig;

    await promptDefaultModel({
      config,
      prompter,
      allowKeep: false,
      includeManual: false,
      agentDir: "/tmp/test-agent",
    });

    const options = select.mock.calls[0]?.[0]?.options ?? [];
    const modelValues = options.map((opt: { value: string }) => opt.value);

    // Should show both models since they're in the allowlist
    expect(modelValues).toContain("anthropic/claude-opus-4-5");
    expect(modelValues).toContain("openai/gpt-5.2");
  });
});
