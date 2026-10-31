import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginRecord } from "../plugins/registry.js";
import { createRuntimeEnv } from "../test-utils/plugin-runtime-env.js";
import type { PluginsListOptions } from "./plugins-list-command.js";

type SnapshotPlugin = Pick<PluginRecord, "id" | "enabled"> &
  Partial<Pick<PluginRecord, "name" | "trust" | "commands" | "agentHarnessIds">>;

function mockPluginListSnapshot(
  plugins: SnapshotPlugin[],
  config: OpenClawConfig = {},
  workspaceWarning?: string,
): void {
  // mock-isolation: Each plugin-list fixture supplies its config without loading operator state.
  vi.doMock("../config/config.js", () => ({
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

const humanModules = [
  "../plugins/source-display.js",
  "../../packages/terminal-core/src/table.js",
  "../../packages/terminal-core/src/theme.js",
  "./command-format.js",
  "./plugins-list-format.js",
];
function mockHumanListModules(width = 120) {
  // mock-isolation: Human-list fixtures use synthetic roots instead of inspecting installed sources.
  vi.doMock("../plugins/source-display.js", () => ({
    formatPluginSourceForTable: () => ({ value: "/workspace/plugins", rootKey: undefined }),
    resolvePluginSourceRoots: () => ({}),
  }));
  vi.doMock("../../packages/terminal-core/src/table.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../packages/terminal-core/src/table.js")>()),
    getTerminalTableWidth: () => width,
  }));
  vi.doMock("./command-format.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("./command-format.js")>()),
    formatCliCommand: (value: string) => `formatted(${value})`,
  }));
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

beforeEach(() => mockHumanListModules());
afterEach(() => {
  for (const module of [
    ...humanModules,
    "../config/config.js",
    "../plugins/status.js",
    "../plugins/status-snapshot.js",
    "./plugins-command-helpers.js",
  ]) {
    vi.doUnmock(module);
  }
  vi.resetModules();
});

it("does not import human list renderers for JSON output", async () => {
  vi.resetModules();
  for (const module of [...humanModules, "../plugins/status.js", "./plugins-command-helpers.js"]) {
    vi.doMock(module, () => {
      throw new Error(`JSON inventory must not load ${module}`);
    });
  }
  mockPluginListSnapshot([
    { id: "demo", enabled: true, commands: ["demo"], agentHarnessIds: ["runtime-only"] },
  ]);

  const writes = await runList({ json: true });

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
  mockHumanListModules(width);
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
    .flatMap((line) => line.split(/[│|]/).slice(-2, -1))
    .map((cell) => cell.trim())
    .join("");
  expect(trustCells).toContain("trusted-official");
  expect(trustCells).toContain("provenance-missing");
  expect(table.split("\n").every((line) => line.length <= width)).toBe(true);
  expect(writes.join("\n")).toContain("Trust is provenance, not a code-safety guarantee.");
});
