import { describe, expect, it, vi } from "vitest";

describe("modelsListCommand forward-compat", () => {
  it("marks configured codex spark as missing when absent from the loaded registry", async () => {
    vi.resetModules();
    const printModelTable = vi.fn();
    const loadModelRegistry = vi
      .fn()
      .mockResolvedValue({ models: [], availableKeys: new Set<string>() });

    vi.doMock("../../config/config.js", () => ({
      loadConfig: vi.fn().mockReturnValue({
        agents: { defaults: { model: { primary: "openai-codex/gpt-5.3-codex-spark" } } },
        models: { providers: {} },
      }),
    }));

    vi.doMock("../../agents/auth-profiles.js", () => ({
      ensureAuthProfileStore: vi.fn().mockReturnValue({ version: 1, profiles: {}, order: {} }),
    }));

    vi.doMock("./list.registry.js", async (importOriginal) => {
      const actual = await importOriginal<typeof import("./list.registry.js")>();
      return {
        ...actual,
        loadModelRegistry,
      };
    });

    vi.doMock("./list.configured.js", () => ({
      resolveConfiguredEntries: vi.fn().mockReturnValue({
        entries: [
          {
            key: "openai-codex/gpt-5.3-codex-spark",
            ref: { provider: "openai-codex", model: "gpt-5.3-codex-spark" },
            tags: new Set(["configured"]),
            aliases: [],
          },
        ],
      }),
    }));

    vi.doMock("./list.table.js", () => ({
      printModelTable,
    }));

    const { modelsListCommand } = await import("./list.list-command.js");
    const runtime = { log: vi.fn(), error: vi.fn() };

    await modelsListCommand({ json: true }, runtime as never);

    expect(printModelTable).toHaveBeenCalled();
    const rows = printModelTable.mock.calls[0]?.[0] as Array<{
      key: string;
      tags: string[];
      missing: boolean;
    }>;

    const spark = rows.find((r) => r.key === "openai-codex/gpt-5.3-codex-spark");
    expect(spark).toBeTruthy();
    expect(spark?.missing).toBe(true);
    expect(spark?.tags).toContain("missing");
  });
});
