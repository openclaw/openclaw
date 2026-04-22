import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { addModelToConfig, listAddableProviders, validateAddProvider } from "./models-add.js";

const configMocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  validateConfigObjectWithPlugins: vi.fn(),
  writeConfigFile: vi.fn(),
}));

const ollamaMocks = vi.hoisted(() => ({
  queryOllamaModelShowInfo: vi.fn(),
}));

const lmstudioRuntimeMocks = vi.hoisted(() => ({
  resolveLmstudioRequestContext: vi.fn(),
}));

const lmstudioFetchMocks = vi.hoisted(() => ({
  fetchLmstudioModels: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: configMocks.readConfigFileSnapshot,
  validateConfigObjectWithPlugins: configMocks.validateConfigObjectWithPlugins,
  writeConfigFile: configMocks.writeConfigFile,
}));

vi.mock("../../../extensions/ollama/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../extensions/ollama/api.js")>();
  return {
    ...actual,
    queryOllamaModelShowInfo: ollamaMocks.queryOllamaModelShowInfo,
  };
});

vi.mock("../../../extensions/lmstudio/runtime-api.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../extensions/lmstudio/runtime-api.js")
  >("../../../extensions/lmstudio/runtime-api.js");
  return {
    ...actual,
    resolveLmstudioRequestContext: lmstudioRuntimeMocks.resolveLmstudioRequestContext,
    fetchLmstudioModels: lmstudioFetchMocks.fetchLmstudioModels,
  };
});

describe("models-add", () => {
  beforeEach(() => {
    configMocks.readConfigFileSnapshot.mockReset();
    configMocks.validateConfigObjectWithPlugins.mockReset();
    configMocks.writeConfigFile.mockReset();
    ollamaMocks.queryOllamaModelShowInfo.mockReset();
    ollamaMocks.queryOllamaModelShowInfo.mockResolvedValue({});
    lmstudioRuntimeMocks.resolveLmstudioRequestContext.mockReset();
    lmstudioFetchMocks.fetchLmstudioModels.mockReset();
  });

  it("lists addable providers only when the write path can actually add them", () => {
    const cfg = {
      models: {
        providers: {
          lmstudio: { baseUrl: "http://localhost:1234/v1", api: "openai-completions", models: [] },
        },
      },
    } as OpenClawConfig;
    expect(
      listAddableProviders({
        cfg,
        discoveredProviders: ["openai", "ollama"],
      }),
    ).toEqual(["lmstudio", "ollama"]);
  });

  it("validates add providers against addable providers", () => {
    const cfg = {} as OpenClawConfig;
    expect(validateAddProvider({ cfg, provider: "ollama", discoveredProviders: [] })).toEqual({
      ok: true,
      provider: "ollama",
    });
    expect(validateAddProvider({ cfg, provider: "missing", discoveredProviders: [] })).toEqual({
      ok: false,
      providers: ["lmstudio", "ollama"],
    });
  });

  it("rejects discovered providers that are not configured for custom models", () => {
    const cfg = {} as OpenClawConfig;

    expect(
      validateAddProvider({
        cfg,
        provider: "openai",
        discoveredProviders: ["openai"],
      }),
    ).toEqual({
      ok: false,
      providers: ["lmstudio", "ollama"],
    });
  });

  it("adds an ollama model and extends the allowlist when needed", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-5" },
          models: {
            "anthropic/claude-opus-4-5": {},
          },
        },
      },
      models: {
        providers: {
          ollama: {
            baseUrl: "http://127.0.0.1:11434",
            api: "ollama",
            models: [],
          },
        },
      },
    } as OpenClawConfig;
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      parsed: cfg,
    });
    ollamaMocks.queryOllamaModelShowInfo.mockResolvedValue({
      contextWindow: 202752,
      capabilities: ["thinking", "tools"],
    });
    configMocks.validateConfigObjectWithPlugins.mockImplementation((config: OpenClawConfig) => ({
      ok: true,
      config,
    }));

    const result = await addModelToConfig({
      cfg,
      provider: "ollama",
      modelId: "glm-5.1:cloud",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.result.existed).toBe(false);
    expect(result.result.allowlistAdded).toBe(true);
    expect(configMocks.writeConfigFile).toHaveBeenCalledTimes(1);
    const written = configMocks.writeConfigFile.mock.calls[0]?.[0] as OpenClawConfig;
    expect(written.models?.providers?.ollama?.models).toEqual([
      expect.objectContaining({
        id: "glm-5.1:cloud",
        reasoning: false,
        contextWindow: 202752,
      }),
    ]);
    expect(written.agents?.defaults?.models?.["ollama/glm-5.1:cloud"]).toEqual({});
  });

  it("treats duplicate provider/model entries as idempotent", async () => {
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-5" },
        },
      },
      models: {
        providers: {
          ollama: {
            baseUrl: "http://127.0.0.1:11434",
            api: "ollama",
            models: [
              {
                id: "glm-5.1:cloud",
                name: "glm-5.1:cloud",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 202752,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    } as OpenClawConfig;
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      parsed: cfg,
    });

    const result = await addModelToConfig({
      cfg,
      provider: "ollama",
      modelId: "glm-5.1:cloud",
    });

    expect(result).toEqual({
      ok: true,
      result: {
        provider: "ollama",
        modelId: "glm-5.1:cloud",
        existed: true,
        allowlistAdded: false,
        warnings: ["Model metadata could not be auto-detected; saved with default capabilities."],
      },
    });
    expect(configMocks.writeConfigFile).not.toHaveBeenCalled();
  });

  it("bootstraps lmstudio provider config when missing", async () => {
    const cfg = {
      agents: { defaults: { model: { primary: "anthropic/claude-opus-4-5" } } },
      models: { providers: {} },
    } as OpenClawConfig;
    configMocks.readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      parsed: cfg,
    });
    lmstudioRuntimeMocks.resolveLmstudioRequestContext.mockResolvedValue({
      apiKey: undefined,
      headers: undefined,
    });
    lmstudioFetchMocks.fetchLmstudioModels.mockResolvedValue({
      reachable: true,
      status: 200,
      models: [
        {
          type: "llm",
          key: "qwen/qwen3.5-9b",
          display_name: "Qwen 3.5 9B",
          max_context_length: 131072,
          capabilities: { reasoning: { allowed_options: ["off", "on"] } },
        },
      ],
    });
    configMocks.validateConfigObjectWithPlugins.mockImplementation((config: OpenClawConfig) => ({
      ok: true,
      config,
    }));

    const result = await addModelToConfig({
      cfg,
      provider: "lmstudio",
      modelId: "qwen/qwen3.5-9b",
    });

    expect(result.ok).toBe(true);
    const written = configMocks.writeConfigFile.mock.calls[0]?.[0] as OpenClawConfig;
    expect(written.models?.providers?.lmstudio?.baseUrl).toBe("http://localhost:1234/v1");
    expect(written.models?.providers?.lmstudio?.api).toBe("openai-completions");
    expect(written.models?.providers?.lmstudio?.models).toEqual([
      expect.objectContaining({
        id: "qwen/qwen3.5-9b",
        name: "Qwen 3.5 9B",
      }),
    ]);
  });
});
