import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const printModelTable = vi.fn();
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
    loadConfig: vi.fn().mockReturnValue({
      agents: { defaults: { model: { primary: "openai-codex/gpt-5.4" } } },
      models: { providers: {} },
    }),
    sourceConfig,
    resolvedConfig,
    loadModelsConfigWithSource: vi.fn().mockResolvedValue({
      sourceConfig,
      resolvedConfig,
      diagnostics: [],
    }),
    ensureAuthProfileStore: vi.fn().mockReturnValue({ version: 1, profiles: {}, order: {} }),
    loadModelRegistry: vi
      .fn()
      .mockResolvedValue({ models: [], availableKeys: new Set(), registry: {} }),
    resolveConfiguredEntries: vi.fn().mockReturnValue({
      entries: [
        {
          key: "openai-codex/gpt-5.4",
          ref: { provider: "openai-codex", model: "gpt-5.4" },
          tags: new Set(["configured"]),
          aliases: [],
        },
      ],
    }),
    printModelTable,
    listProfilesForProvider: vi.fn().mockReturnValue([]),
    resolveModelWithRegistry: vi.fn().mockReturnValue({
      provider: "openai-codex",
      id: "gpt-5.4",
      name: "GPT-5.4",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      input: ["text"],
      contextWindow: 1_050_000,
      maxTokens: 128000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }),
  };
});

vi.mock("../../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
}));

vi.mock("../../agents/auth-profiles.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/auth-profiles.js")>();
  return {
    ...actual,
    ensureAuthProfileStore: mocks.ensureAuthProfileStore,
    listProfilesForProvider: mocks.listProfilesForProvider,
  };
});

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

describe("modelsListCommand forward-compat", () => {
  it("does not mark configured codex model as missing when forward-compat can build a fallback", async () => {
    const runtime = { log: vi.fn(), error: vi.fn() };

    await modelsListCommand({ json: true }, runtime as never);

    expect(mocks.printModelTable).toHaveBeenCalled();
    const rows = mocks.printModelTable.mock.calls[0]?.[0] as Array<{
      key: string;
      tags: string[];
      missing: boolean;
    }>;

    const codex = rows.find((r) => r.key === "openai-codex/gpt-5.4");
    expect(codex).toBeTruthy();
    expect(codex?.missing).toBe(false);
    expect(codex?.tags).not.toContain("missing");
  });

  it("passes source config to model registry loading for persistence safety", async () => {
    const runtime = { log: vi.fn(), error: vi.fn() };

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
    const runtime = { log: vi.fn(), error: vi.fn() };

    await modelsListCommand({ json: true, local: true }, runtime as never);

    expect(mocks.printModelTable).toHaveBeenCalled();
    const rows = mocks.printModelTable.mock.calls.at(-1)?.[0] as Array<{ key: string }>;
    expect(rows).toEqual([
      expect.objectContaining({
        key: "openai/gpt-5.4",
      }),
    ]);
  });

  it("marks synthetic codex gpt-5.4 rows as available when provider auth exists", async () => {
    mocks.loadModelRegistry.mockResolvedValueOnce({
      models: [],
      availableKeys: new Set(),
      registry: {},
    });
    mocks.listProfilesForProvider.mockImplementationOnce((_: unknown, provider: string) =>
      provider === "openai-codex" ? ([{ id: "profile-1" }] as Array<Record<string, unknown>>) : [],
    );
    const runtime = { log: vi.fn(), error: vi.fn() };

    await modelsListCommand({ json: true }, runtime as never);

    expect(mocks.printModelTable).toHaveBeenCalled();
    const rows = mocks.printModelTable.mock.calls.at(-1)?.[0] as Array<{
      key: string;
      available: boolean;
    }>;

    expect(rows).toContainEqual(
      expect.objectContaining({
        key: "openai-codex/gpt-5.4",
        available: true,
      }),
    );
  });

  it("exits with an error when configured-mode listing has no model registry", async () => {
    vi.clearAllMocks();
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    mocks.loadModelRegistry.mockResolvedValueOnce({
      models: [],
      availableKeys: new Set<string>(),
      registry: undefined,
    });
    const runtime = { log: vi.fn(), error: vi.fn() };
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
