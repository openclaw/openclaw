import { beforeEach, describe, expect, it, vi } from "vitest";

const OPENAI_CODEX_MODEL = {
  provider: "openai-codex",
  id: "gpt-5.4",
  name: "GPT-5.4",
  api: "openai-codex-responses",
  baseUrl: "https://chatgpt.com/backend-api",
  input: ["text"],
  contextWindow: 1_050_000,
  maxTokens: 128000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const OPENAI_CODEX_53_MODEL = {
  ...OPENAI_CODEX_MODEL,
  id: "gpt-5.4",
  name: "GPT-5.3 Codex",
};

const mocks = vi.hoisted(() => {
  const sourceConfig = {
    agents: { defaults: { model: { primary: "openai-codex/gpt-5.4" } } },
    models: {
      providers: {
        openai: {
          apiKey: "$OPENAI_API_KEY", // pragma: allowlist secret
        },
      },
    },
  };
  const resolvedConfig = {
    agents: { defaults: { model: { primary: "openai-codex/gpt-5.4" } } },
    models: {
      providers: {
        openai: {
          apiKey: "sk-resolved-runtime-value", // pragma: allowlist secret
        },
      },
    },
  };
  return {
    sourceConfig,
    resolvedConfig,
    loadConfig: vi.fn(),
    loadModelsConfigWithSource: vi.fn(),
    ensureAuthProfileStore: vi.fn(),
    loadModelRegistry: vi.fn(),
    loadModelCatalog: vi.fn(),
    resolveConfiguredEntries: vi.fn(),
    printModelTable: vi.fn(),
    listProfilesForProvider: vi.fn(),
    resolveModelWithRegistry: vi.fn(),
  };
});

function resetMocks() {
  mocks.loadConfig.mockReturnValue({
    agents: { defaults: { model: { primary: "openai-codex/gpt-5.4" } } },
    models: { providers: {} },
  });
  mocks.loadModelsConfigWithSource.mockResolvedValue({
    sourceConfig: mocks.sourceConfig,
    resolvedConfig: mocks.resolvedConfig,
    diagnostics: [],
  });
  mocks.ensureAuthProfileStore.mockReturnValue({ version: 1, profiles: {}, order: {} });
  mocks.loadModelRegistry.mockResolvedValue({
    models: [],
    availableKeys: new Set(),
    registry: {
      getAll: () => [],
    },
  });
  mocks.loadModelCatalog.mockResolvedValue([]);
  mocks.resolveConfiguredEntries.mockReturnValue({
    entries: [
      {
        key: "openai-codex/gpt-5.4",
        ref: { provider: "openai-codex", model: "gpt-5.4" },
        tags: new Set(["configured"]),
        aliases: [],
      },
    ],
  });
  mocks.printModelTable.mockReset();
  mocks.listProfilesForProvider.mockReturnValue([]);
  mocks.resolveModelWithRegistry.mockReturnValue({ ...OPENAI_CODEX_MODEL });
}

function createRuntime() {
  return { log: vi.fn(), error: vi.fn() };
}

function lastPrintedRows<T>() {
  return (mocks.printModelTable.mock.calls.at(-1)?.[0] ?? []) as T[];
}

function mockDiscoveredCodex53Registry() {
  mocks.resolveConfiguredEntries.mockReturnValueOnce({ entries: [] });
  mocks.loadModelRegistry.mockResolvedValueOnce({
    models: [{ ...OPENAI_CODEX_53_MODEL }],
    availableKeys: new Set(["openai-codex/gpt-5.4"]),
    registry: {
      getAll: () => [{ ...OPENAI_CODEX_53_MODEL }],
    },
  });
}

async function runAllOpenAiCodexCommand() {
  const runtime = createRuntime();
  await modelsListCommand({ all: true, provider: "openai-codex", json: true }, runtime as never);
  expect(mocks.printModelTable).toHaveBeenCalled();
}

vi.mock("../../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
  getRuntimeConfigSnapshot: vi.fn().mockReturnValue(null),
  getRuntimeConfigSourceSnapshot: vi.fn().mockReturnValue(null),
}));

vi.mock("../../agents/auth-profiles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/auth-profiles.js")>();
  return {
    ...actual,
    ensureAuthProfileStore: mocks.ensureAuthProfileStore,
    listProfilesForProvider: mocks.listProfilesForProvider,
  };
});

vi.mock("../../agents/model-catalog.js", () => ({
  loadModelCatalog: mocks.loadModelCatalog,
}));

vi.mock("./list.registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./list.registry.js")>();
  return {
    ...actual,
    loadModelRegistry: mocks.loadModelRegistry,
  };
});

vi.mock("./load-config.js", () => ({
  loadModelsConfigWithSource: mocks.loadModelsConfigWithSource,
}));

vi.mock("./list.configured.js", () => ({
  resolveConfiguredEntries: mocks.resolveConfiguredEntries,
}));

vi.mock("./list.table.js", () => ({
  printModelTable: mocks.printModelTable,
}));

vi.mock("../../agents/pi-embedded-runner/model.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/pi-embedded-runner/model.js")>();
  return {
    ...actual,
    resolveModelWithRegistry: mocks.resolveModelWithRegistry,
  };
});

import { modelsListCommand } from "./list.list-command.js";

beforeEach(() => {
  vi.clearAllMocks();
  resetMocks();
});

describe("modelsListCommand forward-compat", () => {
  describe("configured rows", () => {
    it("does not mark configured codex model as missing when forward-compat can build a fallback", async () => {
      const runtime = createRuntime();

      await modelsListCommand({ json: true }, runtime as never);

      expect(mocks.printModelTable).toHaveBeenCalled();
      const rows = lastPrintedRows<{
        key: string;
        tags: string[];
        missing: boolean;
      }>();

      const codex = rows.find((row) => row.key === "openai-codex/gpt-5.4");
      expect(codex).toBeTruthy();
      expect(codex?.missing).toBe(false);
      expect(codex?.tags).not.toContain("missing");
    });

    it("passes source config to model registry loading for persistence safety", async () => {
      const runtime = createRuntime();

      await modelsListCommand({ json: true }, runtime as never);

      expect(mocks.loadModelRegistry).toHaveBeenCalledWith(mocks.resolvedConfig, {
        sourceConfig: mocks.sourceConfig,
      });
    });

    it("keeps configured local openai gpt-5.4 entries visible in --local output", async () => {
      mocks.resolveConfiguredEntries.mockReturnValueOnce({
        entries: [
          {
            key: "openai/gpt-5.4",
            ref: { provider: "openai", model: "gpt-5.4" },
            tags: new Set(["configured"]),
            aliases: [],
          },
        ],
      });
      mocks.resolveModelWithRegistry.mockReturnValueOnce({
        provider: "openai",
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-responses",
        baseUrl: "http://localhost:4000/v1",
        input: ["text", "image"],
        contextWindow: 1_050_000,
        maxTokens: 128_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      });
      const runtime = createRuntime();

      await modelsListCommand({ json: true, local: true }, runtime as never);

      expect(mocks.printModelTable).toHaveBeenCalled();
      expect(lastPrintedRows<{ key: string }>()).toEqual([
        expect.objectContaining({
          key: "openai/gpt-5.4",
        }),
      ]);
    });
  });

  describe("availability fallback", () => {
    it("marks synthetic codex gpt-5.4 rows as available when provider auth exists", async () => {
      mocks.listProfilesForProvider.mockImplementation((_: unknown, provider: string) =>
        provider === "openai-codex"
          ? ([{ id: "profile-1" }] as Array<Record<string, unknown>>)
          : [],
      );
      const runtime = createRuntime();

      await modelsListCommand({ json: true }, runtime as never);

      expect(mocks.printModelTable).toHaveBeenCalled();
      expect(lastPrintedRows<{ key: string; available: boolean }>()).toContainEqual(
        expect.objectContaining({
          key: "openai-codex/gpt-5.4",
          available: true,
        }),
      );
    });

    it("exits with an error when configured-mode listing has no model registry", async () => {
      const previousExitCode = process.exitCode;
      process.exitCode = undefined;
      mocks.loadModelRegistry.mockResolvedValueOnce({
        models: [],
        availableKeys: new Set<string>(),
        registry: undefined,
      });
      const runtime = createRuntime();
      let observedExitCode: number | undefined;

      try {
        await modelsListCommand({ json: true }, runtime as never);
        observedExitCode = process.exitCode;
      } finally {
        process.exitCode = previousExitCode;
      }

      expect(runtime.error).toHaveBeenCalledWith("Model registry unavailable.");
      expect(observedExitCode).toBe(1);
      expect(mocks.printModelTable).not.toHaveBeenCalled();
    });
  });

  describe("--all catalog supplementation", () => {
    it("includes synthetic codex gpt-5.4 in --all output when catalog supports it", async () => {
      mockDiscoveredCodex53Registry();
      mocks.loadModelCatalog.mockResolvedValueOnce([
        {
          provider: "openai-codex",
          id: "gpt-5.4",
          name: "GPT-5.3 Codex",
          input: ["text"],
          contextWindow: 272000,
        },
        {
          provider: "openai-codex",
          id: "gpt-5.4",
          name: "GPT-5.4",
          input: ["text"],
          contextWindow: 272000,
        },
      ]);
      mocks.listProfilesForProvider.mockImplementation((_: unknown, provider: string) =>
        provider === "openai-codex"
          ? ([{ id: "profile-1" }] as Array<Record<string, unknown>>)
          : [],
      );
      mocks.resolveModelWithRegistry.mockImplementation(
        ({ provider, modelId }: { provider: string; modelId: string }) => {
          if (provider !== "openai-codex") {
            return undefined;
          }
          if (modelId === "gpt-5.4") {
            return { ...OPENAI_CODEX_53_MODEL };
          }
          if (modelId === "gpt-5.4") {
            return { ...OPENAI_CODEX_MODEL };
          }
          return undefined;
        },
      );
      await runAllOpenAiCodexCommand();
      expect(lastPrintedRows<{ key: string; available: boolean }>()).toEqual([
        expect.objectContaining({
          key: "openai-codex/gpt-5.4",
        }),
        expect.objectContaining({
          key: "openai-codex/gpt-5.4",
          available: true,
        }),
      ]);
    });

    it("keeps discovered rows in --all output when catalog lookup is empty", async () => {
      mockDiscoveredCodex53Registry();
      mocks.loadModelCatalog.mockResolvedValueOnce([]);
      await runAllOpenAiCodexCommand();
      expect(lastPrintedRows<{ key: string }>()).toEqual([
        expect.objectContaining({
          key: "openai-codex/gpt-5.4",
        }),
      ]);
    });

    it("suppresses direct openai gpt-5.3-codex-spark rows in --all output", async () => {
      mocks.resolveConfiguredEntries.mockReturnValueOnce({ entries: [] });
      mocks.loadModelRegistry.mockResolvedValueOnce({
        models: [
          {
            provider: "openai",
            id: "gpt-5.3-codex-spark",
            name: "GPT-5.3 Codex Spark",
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            input: ["text", "image"],
            contextWindow: 128000,
            maxTokens: 32000,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
          {
            provider: "azure-openai-responses",
            id: "gpt-5.3-codex-spark",
            name: "GPT-5.3 Codex Spark",
            api: "azure-openai-responses",
            baseUrl: "https://example.openai.azure.com/openai/v1",
            input: ["text", "image"],
            contextWindow: 128000,
            maxTokens: 32000,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
          { ...OPENAI_CODEX_53_MODEL },
        ],
        availableKeys: new Set([
          "openai/gpt-5.3-codex-spark",
          "azure-openai-responses/gpt-5.3-codex-spark",
          "openai-codex/gpt-5.4",
        ]),
        registry: {
          getAll: () => [{ ...OPENAI_CODEX_53_MODEL }],
        },
      });
      mocks.loadModelCatalog.mockResolvedValueOnce([]);
      const runtime = createRuntime();

      await modelsListCommand({ all: true, json: true }, runtime as never);

      expect(mocks.printModelTable).toHaveBeenCalled();
      expect(lastPrintedRows<{ key: string }>()).toEqual([
        expect.objectContaining({
          key: "openai-codex/gpt-5.4",
        }),
      ]);
    });
  });
});
