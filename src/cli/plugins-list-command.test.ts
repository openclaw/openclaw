// Plugins list command tests cover plugin list command execution and output.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OutputRuntimeEnv } from "../runtime.js";

function createJsonRuntime(writes: unknown[]): OutputRuntimeEnv {
  return {
    log: (...args: unknown[]) => writes.push(args.length === 1 ? args[0] : args),
    error: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`exit ${code}`);
    }),
    writeStdout: (value: string) => writes.push(value),
    writeJson: (value: unknown) => writes.push(value),
  };
}

type SnapshotPlugin = {
  id: string;
  enabled: boolean;
  name?: string;
  description?: string;
  version?: string;
  commands?: string[];
  agentHarnessIds?: string[];
};

function mockPluginListSnapshot(
  plugins: SnapshotPlugin[],
  config: OpenClawConfig = {},
  scope?: {
    workspaceDir?: string;
    workspaceScope: "selected" | "omitted";
    diagnostics?: Array<{ level: "warn"; code: "workspace-scope-omitted"; message: string }>;
  },
): void {
  // mock-isolation: Each plugin-list fixture supplies its config without loading operator state.
  vi.doMock("../config/config.js", () => ({
    getRuntimeConfig: () => config,
    loadConfig: () => config,
    captureRuntimeConfigAsyncReader: () => async () => config,
  }));
  vi.doMock("../plugins/status-snapshot.js", () => ({
    buildPluginRegistrySnapshotReport: () => ({
      workspaceDir: scope?.workspaceDir ?? "/workspace",
      workspaceScope: scope?.workspaceScope ?? "selected",
      registrySource: "config",
      registryDiagnostics: [],
      plugins,
      diagnostics: scope?.diagnostics ?? [],
    }),
  }));
}

function mockHumanListModules(importedModules: string[] = []): void {
  vi.doMock("../plugins/source-display.js", () => {
    importedModules.push("source-display");
    return {
      formatPluginSourceForTable: vi.fn(),
      resolvePluginSourceRoots: vi.fn(),
    };
  });
  vi.doMock("../../packages/terminal-core/src/table.js", () => {
    importedModules.push("table");
    return {
      getTerminalTableWidth: vi.fn(),
      renderTable: vi.fn(() => ""),
    };
  });
  vi.doMock("../../packages/terminal-core/src/theme.js", () => {
    importedModules.push("theme");
    return {
      theme: {
        command: (value: string) => value,
        error: (value: string) => value,
        heading: (value: string) => value,
        muted: (value: string) => value,
        warn: (value: string) => value,
      },
    };
  });
  vi.doMock("./command-format.js", () => {
    importedModules.push("command-format");
    return {
      formatCliCommand: (value: string) => `formatted(${value})`,
    };
  });
  vi.doMock("./plugins-list-format.js", () => {
    importedModules.push("plugins-list-format");
    return {
      formatPluginLine: vi.fn(),
      formatPluginStatus: vi.fn(),
    };
  });
}

describe("runPluginsListCommand", () => {
  afterEach(() => {
    vi.doUnmock("../config/config.js");
    vi.doUnmock("../plugins/status.js");
    vi.doUnmock("../plugins/status-snapshot.js");
    vi.doUnmock("../plugins/source-display.js");
    vi.doUnmock("../../packages/terminal-core/src/table.js");
    vi.doUnmock("../../packages/terminal-core/src/theme.js");
    vi.doUnmock("./command-format.js");
    vi.doUnmock("./plugins-list-format.js");
    vi.resetModules();
  });

  it("does not import human list renderers for JSON output", async () => {
    vi.resetModules();
    const importedHumanModules: string[] = [];

    vi.doMock("../plugins/status.js", () => {
      throw new Error("plugins list JSON must use the snapshot status module");
    });
    vi.doMock("./plugins-command-helpers.js", () => {
      throw new Error("plugins list JSON must not import plugin command helpers");
    });
    mockPluginListSnapshot([
      { id: "demo", enabled: true, commands: ["demo"], agentHarnessIds: ["runtime-only"] },
    ]);
    mockHumanListModules(importedHumanModules);

    const { runPluginsListCommand } = await import("./plugins-list-command.js");
    const writes: unknown[] = [];

    await runPluginsListCommand({ json: true }, createJsonRuntime(writes));

    expect(importedHumanModules).toEqual([]);
    expect(writes).toEqual([
      {
        workspaceDir: "/workspace",
        workspaceScope: "selected",
        registry: {
          source: "config",
          diagnostics: [],
        },
        plugins: [{ id: "demo", enabled: true, commands: ["demo"] }],
        diagnostics: [],
      },
    ]);
  });

  it("explains an empty enabled-only list when plugins are installed", async () => {
    mockPluginListSnapshot([{ id: "disabled-plugin", enabled: false }]);
    mockHumanListModules();
    const { runPluginsListCommand } = await import("./plugins-list-command.js");
    const writes: unknown[] = [];

    await runPluginsListCommand({ enabled: true }, createJsonRuntime(writes));

    expect(writes).toEqual([
      "No enabled plugins found. Run formatted(openclaw plugins list) to inspect installed plugins.",
    ]);
  });

  it("explains a globally disabled plugin inventory", async () => {
    mockPluginListSnapshot([{ id: "disabled-plugin", enabled: false }], {
      plugins: { enabled: false },
    });
    mockHumanListModules();
    const { runPluginsListCommand } = await import("./plugins-list-command.js");
    const writes: unknown[] = [];

    await runPluginsListCommand({ enabled: true, verbose: true }, createJsonRuntime(writes));

    expect(writes).toEqual([
      "No enabled plugins found. Plugins are globally disabled. Run formatted(openclaw plugins list) to inspect installed plugins.",
    ]);
  });

  it("strips terminal controls from plugin display metadata in the human table", async () => {
    mockPluginListSnapshot(
      [
        {
          id: "evil",
          enabled: true,
          name: "Evil \u001B[31mRED\u0007",
          description: "Desc \u001B[2Jwiped\u0007 tail",
          version: "1.0.0\u001B[1m",
        },
      ],
      { plugins: { enabled: true } },
    );
    mockHumanListModules();

    const sourceDisplay = await import("../plugins/source-display.js");
    vi.mocked(sourceDisplay.formatPluginSourceForTable).mockReturnValue({
      value: "global:evil",
    } as never);
    vi.mocked(sourceDisplay.resolvePluginSourceRoots).mockReturnValue({} as never);

    const table = await import("../../packages/terminal-core/src/table.js");
    const { runPluginsListCommand } = await import("./plugins-list-command.js");
    await runPluginsListCommand({}, createJsonRuntime([]));

    const tableArgs = vi.mocked(table.renderTable).mock.calls[0]?.[0] as {
      rows: Array<Record<string, string>>;
    };
    const row = tableArgs.rows[0];
    // Manifest text is display metadata: the terminal renders the words, never the escapes.
    expect(row?.Name).toBe("Evil RED");
    expect(row?.Source).toContain("Desc wiped tail");
    expect(row?.Version).toBe("1.0.0");
    expect(JSON.stringify(row)).not.toContain("\u001B");
    expect(JSON.stringify(row)).not.toContain("\u0007");
  });

  it("makes omitted workspace plugin scope visible in human output", async () => {
    const message =
      "Workspace plugin discovery was skipped; set agents.defaults.systemAgent.agentId.";
    mockPluginListSnapshot(
      [],
      {},
      {
        workspaceScope: "omitted",
        diagnostics: [{ level: "warn", code: "workspace-scope-omitted", message }],
      },
    );
    mockHumanListModules();
    const { runPluginsListCommand } = await import("./plugins-list-command.js");
    const writes: unknown[] = [];

    await runPluginsListCommand({}, createJsonRuntime(writes));

    expect(writes).toEqual([
      `Warning: ${message}`,
      "",
      "No plugins found. Run formatted(openclaw plugins install <plugin>) to add one, or formatted(openclaw plugins list --json) to inspect raw discovery state.",
    ]);
  });
});
