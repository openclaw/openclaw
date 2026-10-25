import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginRecord } from "../plugins/registry.js";
import { createRuntimeEnv } from "../test-utils/plugin-runtime-env.js";
import type { PluginsListOptions } from "./plugins-list-command.js";

type SnapshotPlugin = {
  id: string;
  enabled: boolean;
  name?: string;
  trust?: PluginRecord["trust"];
  commands?: string[];
  agentHarnessIds?: string[];
};

function mockPluginListSnapshot(
  plugins: SnapshotPlugin[],
  config: OpenClawConfig = {},
  workspaceWarning?: string,
): void {
  // mock-isolation: Each plugin-list fixture supplies its config without loading operator state.
  vi.doMock("../config/config.js", () => ({
    getRuntimeConfig: () => config,
    loadConfig: () => config,
    captureRuntimeConfigAsyncReader: () => async () => config,
  }));
  // mock-isolation: Supply synthetic inventory without discovering installed plugins.
  vi.doMock("../plugins/status-snapshot.js", () => ({
    buildPluginRegistrySnapshotReport: () => ({
      workspaceDir: "/workspace",
      workspaceScope: workspaceWarning ? "omitted" : "selected",
      registrySource: "config",
      registryDiagnostics: [],
      plugins,
      diagnostics: workspaceWarning
        ? [{ level: "warn", code: "workspace-scope-omitted", message: workspaceWarning }]
        : [],
    }),
  }));
}

function mockHumanListModules(importedModules: string[] = [], width = 120): void {
  // mock-isolation: discovery roots are synthetic; formatting uses the real implementations.
  vi.doMock("../plugins/source-display.js", () => {
    importedModules.push("source-display");
    return {
      formatPluginSourceForTable: () => ({ value: "/workspace/plugins", rootKey: undefined }),
      resolvePluginSourceRoots: () => ({}),
    };
  });
  vi.doMock("../../packages/terminal-core/src/table.js", async (importOriginal) => {
    importedModules.push("table");
    const actual =
      await importOriginal<typeof import("../../packages/terminal-core/src/table.js")>();
    return { ...actual, getTerminalTableWidth: () => width };
  });
  vi.doMock("../../packages/terminal-core/src/theme.js", async (importOriginal) => {
    importedModules.push("theme");
    return await importOriginal<typeof import("../../packages/terminal-core/src/theme.js")>();
  });
  vi.doMock("./plugins-list-format.js", async (importOriginal) => {
    importedModules.push("format");
    return await importOriginal<typeof import("./plugins-list-format.js")>();
  });
  vi.doMock("./command-format.js", async (importOriginal) => {
    importedModules.push("command-format");
    return {
      ...(await importOriginal<typeof import("./command-format.js")>()),
      formatCliCommand: (value: string) => `formatted(${value})`,
    };
  });
}

async function runList(options: PluginsListOptions) {
  const { runPluginsListCommand } = await import("./plugins-list-command.js");
  const writes: unknown[] = [];
  const runtime = {
    ...createRuntimeEnv(),
    log: (...args: unknown[]) => writes.push(args.length === 1 ? args[0] : args),
    writeStdout: (value: string) => writes.push(value),
    writeJson: (value: unknown) => writes.push(value),
  };
  await runPluginsListCommand(options, runtime);
  return writes;
}

const importedHumanModules: string[] = [];
beforeEach(() => {
  importedHumanModules.length = 0;
  mockHumanListModules(importedHumanModules);
});
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
  vi.doMock("../plugins/status.js", () => {
    throw new Error("plugins list JSON must use the snapshot status module");
  });
  vi.doMock("./plugins-command-helpers.js", () => {
    throw new Error("plugins list JSON must not import plugin command helpers");
  });
  mockPluginListSnapshot([
    { id: "demo", enabled: true, commands: ["demo"], agentHarnessIds: ["runtime-only"] },
  ]);

  const writes = await runList({ json: true });

  expect(importedHumanModules).toEqual([]);
  expect(writes).toEqual([
    {
      workspaceDir: "/workspace",
      workspaceScope: "selected",
      registry: { source: "config", diagnostics: [] },
      plugins: [{ id: "demo", enabled: true, commands: ["demo"] }],
      diagnostics: [],
    },
  ]);
});

it.each([
  [false, ""],
  [true, " Plugins are globally disabled."],
] as const)(
  "explains an empty enabled-only list (globally disabled=%s)",
  async (disabled, reason) => {
    mockPluginListSnapshot(
      [{ id: "disabled-plugin", enabled: false }],
      disabled ? { plugins: { enabled: false } } : {},
    );
    expect(await runList({ enabled: true, verbose: disabled })).toEqual([
      `No enabled plugins found.${reason} Run formatted(openclaw plugins list) to inspect installed plugins.`,
    ]);
  },
);

it("makes omitted workspace plugin scope visible in human output", async () => {
  const message =
    "Workspace plugin discovery was skipped; set agents.defaults.systemAgent.agentId.";
  mockPluginListSnapshot([], {}, message);
  expect(await runList({})).toEqual([
    `Warning: ${message}`,
    "",
    "No plugins found. Run formatted(openclaw plugins install <plugin>) to add one, or formatted(openclaw plugins list --json) to inspect raw discovery state.",
  ]);
});

it.each([80, 120])("shows trust provenance within a %s-column table", async (width) => {
  mockHumanListModules(importedHumanModules, width);
  mockPluginListSnapshot([
    {
      id: "official",
      enabled: true,
      trust: { reason: "trusted-official", registryPath: null, origin: "global" },
    },
    {
      id: "external",
      enabled: true,
      trust: { reason: "provenance-missing", registryPath: null, origin: "global" },
    },
  ]);
  const writes = await runList({});
  const table = stripVTControlCharacters(
    writes.map(String).find((line) => /[│|] Name\s+[│|]/.test(line)) ?? "",
  );
  expect(table).toMatch(/[│|] Trust\s+[│|]/);
  expect(table).toMatch(/[│|] official\s+[│|]/);
  expect(table).toMatch(/[│|] external\s+[│|]/);
  const trustCells = table
    .split("\n")
    .filter((line) => /^[│|]/.test(line))
    .map((line) =>
      line
        .split(/[│|]/)
        .at(-2)
        ?.trim(),
    )
    .join("");
  expect(trustCells).toContain("trusted-official");
  expect(trustCells).toContain("provenance-missing");
  expect(table.split("\n").every((line) => line.length <= width)).toBe(true);
  expect(writes.join("\n")).toContain("Trust is provenance, not a code-safety guarantee.");
});
