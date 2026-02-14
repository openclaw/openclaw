import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const printModelTable = vi.fn();
  return {
    loadConfig: vi.fn().mockReturnValue({
      agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex" } } },
      models: { providers: {} },
    }),
    ensureAuthProfileStore: vi.fn().mockReturnValue({ version: 1, profiles: {}, order: {} }),
    loadModelRegistry: vi
      .fn()
      .mockResolvedValue({ models: [], availableKeys: new Set(), registry: {} }),
    resolveConfiguredEntries: vi.fn().mockReturnValue({
      entries: [
        {
          key: "openai-codex/gpt-5.3-codex",
          ref: { provider: "openai-codex", model: "gpt-5.3-codex" },
          tags: new Set(["configured"]),
          aliases: [],
        },
      ],
    }),
    printModelTable,
    resolveForwardCompatModel: vi.fn().mockReturnValue({
      provider: "openai-codex",
      id: "gpt-5.3-codex",
      name: "GPT-5.3 Codex",
      api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api",
      input: ["text"],
      contextWindow: 272000,
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
    listProfilesForProvider: vi.fn().mockReturnValue([]),
  };
});

vi.mock("./list.registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./list.registry.js")>();
  return {
    ...actual,
    loadModelRegistry: mocks.loadModelRegistry,
  };
});

vi.mock("./list.configured.js", () => ({
  resolveConfiguredEntries: mocks.resolveConfiguredEntries,
}));

vi.mock("./list.table.js", () => ({
  printModelTable: mocks.printModelTable,
}));

vi.mock("../../agents/model-forward-compat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/model-forward-compat.js")>();
  return {
    ...actual,
    resolveForwardCompatModel: mocks.resolveForwardCompatModel,
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

    const codex = rows.find((r) => r.key === "openai-codex/gpt-5.3-codex");
    expect(codex).toBeTruthy();
    expect(codex?.missing).toBe(false);
    expect(codex?.tags).not.toContain("missing");
  });
});
