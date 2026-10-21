import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as noteModule from "../../packages/terminal-core/src/note.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshotScopeRunner } from "../plugins/current-plugin-metadata-snapshot.js";
import type { PluginVersionDriftReport } from "../plugins/plugin-version-drift.js";
import {
  createPluginLoadResult,
  createPluginRecord,
  createTypedHook,
} from "../plugins/status.test-fixtures.js";
import {
  collectWorkspaceStatusHealthFindings,
  noteWorkspaceStatus,
} from "./doctor-workspace-status.js";

const mocks = vi.hoisted(() => ({
  listAgentIds: vi.fn<(_cfg: OpenClawConfig) => string[]>(() => ["default"]),
  resolveAgentWorkspaceDir: vi.fn(),
  buildPluginRegistrySnapshotReport: vi.fn(),
  buildPluginCompatibilityWarnings: vi.fn(),
}));
vi.mock("../agents/agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/agent-scope.js")>()),
  listAgentIds: (cfg: OpenClawConfig) => mocks.listAgentIds(cfg),
  resolveAgentWorkspaceDir: (...args: unknown[]) => mocks.resolveAgentWorkspaceDir(...args),
}));
vi.mock("../plugins/status.js", () => ({
  buildPluginRegistrySnapshotReport: (...args: unknown[]) =>
    mocks.buildPluginRegistrySnapshotReport(...args),
  buildPluginCompatibilityWarnings: (...args: unknown[]) =>
    mocks.buildPluginCompatibilityWarnings(...args),
}));

function setReport(loadResult = createPluginLoadResult({ plugins: [] }), warnings: string[] = []) {
  mocks.buildPluginRegistrySnapshotReport.mockReturnValue({
    workspaceDir: "/workspace",
    ...loadResult,
  });
  mocks.buildPluginCompatibilityWarnings.mockReturnValue(warnings);
}
beforeEach(() => {
  mocks.listAgentIds.mockReturnValue(["default"]);
  mocks.resolveAgentWorkspaceDir.mockReturnValue("/workspace");
  setReport();
});
afterEach(() => vi.restoreAllMocks());

const spyNotes = () => vi.spyOn(noteModule, "note").mockImplementation(() => {});
function noteBody(spy: ReturnType<typeof spyNotes>, title: string) {
  const calls = spy.mock.calls.filter(([, heading]) => heading === title);
  expect(calls).toHaveLength(1);
  return calls[0]![0];
}
type Drift = PluginVersionDriftReport["drifts"][number];
function readiness(entry: Drift) {
  return {
    pluginVersionReadiness: {
      status: "resolved" as const,
      report: { gatewayVersion: entry.gatewayVersion, drifts: [entry] },
    },
  };
}
const codexDrift: Drift = {
  pluginId: "codex",
  installedVersion: "2026.5.30-beta.1",
  gatewayVersion: "2026.6.1",
  source: "npm",
};
function showDrift(entry: Drift) {
  setReport(
    createPluginLoadResult({
      plugins: [createPluginRecord({ id: entry.pluginId })],
    }),
  );
  const spy = spyNotes();
  noteWorkspaceStatus(
    { plugins: { entries: { [entry.pluginId]: { enabled: true } } } },
    readiness(entry),
  );
  return noteBody(spy, "Plugin restart readiness");
}

it("passes the shared status report into compatibility warnings", () => {
  const loadResult = createPluginLoadResult({
    plugins: [createPluginRecord({ id: "legacy-plugin", name: "Legacy Plugin", hookCount: 1 })],
    typedHooks: [createTypedHook({ pluginId: "legacy-plugin", hookName: "before_prompt_build" })],
  });
  setReport(loadResult, ["legacy-plugin is hook-only"]);
  const spy = spyNotes();
  noteWorkspaceStatus({});
  expect(mocks.buildPluginRegistrySnapshotReport).toHaveBeenCalledWith({
    config: {},
    workspaceDir: "/workspace",
  });
  expect(mocks.buildPluginCompatibilityWarnings).toHaveBeenCalledWith({
    config: {},
    workspaceDir: "/workspace",
    report: { workspaceDir: "/workspace", ...loadResult },
  });
  expect(noteBody(spy, "Plugin compatibility")).toContain("legacy-plugin is hook-only");
});

it("shares scoped workspace inspection while reporting identical registrar failures once", () => {
  const diagnostic = {
    level: "error" as const,
    pluginId: "broken-fixture",
    source: "/plugins/broken-fixture/index.js",
    message: "board widget registration has invalid kind",
  };
  mocks.listAgentIds.mockReturnValue(["alpha", "beta"]);
  mocks.resolveAgentWorkspaceDir.mockImplementation((_cfg, agentId) => "/workspace/" + agentId);
  let activeWorkspace: string | undefined;
  const runWithPluginMetadataSnapshot: PluginMetadataSnapshotScopeRunner = (scope, run) => {
    activeWorkspace = scope.workspaceDir;
    try {
      return run();
    } finally {
      activeWorkspace = undefined;
    }
  };
  mocks.buildPluginRegistrySnapshotReport.mockImplementation(({ workspaceDir }) => {
    expect(activeWorkspace).toBe(workspaceDir);
    return {
      workspaceDir,
      ...createPluginLoadResult({ plugins: [], diagnostics: [diagnostic] }),
    };
  });
  mocks.buildPluginCompatibilityWarnings.mockImplementation(({ workspaceDir }) => {
    expect(activeWorkspace).toBe(workspaceDir);
    return ["legacy-plugin is hook-only"];
  });
  const spy = vi.spyOn(noteModule, "note").mockImplementation(() => {
    expect(activeWorkspace).toBeDefined();
  });
  noteWorkspaceStatus({}, { runWithPluginMetadataSnapshot });
  expect(spy.mock.calls).toEqual([
    ['Agent "alpha":\n- legacy-plugin is hook-only', "Plugin compatibility"],
    [
      'Agent "alpha":\n- ERROR broken-fixture: board widget registration has invalid kind (/plugins/broken-fixture/index.js)',
      "Plugin diagnostics",
    ],
    ['Agent "beta":\n- legacy-plugin is hook-only', "Plugin compatibility"],
  ]);
  const findings = collectWorkspaceStatusHealthFindings({}, { runWithPluginMetadataSnapshot });
  expect(findings.map((finding) => finding.message)).toEqual([
    'Agent "alpha": legacy-plugin is hook-only',
    'Agent "alpha": board widget registration has invalid kind',
    'Agent "beta": legacy-plugin is hook-only',
  ]);
  expect(findings.filter((finding) => finding.target === "broken-fixture")).toHaveLength(1);
  expect(activeWorkspace).toBeUndefined();
});

it("lists only errored plugin ids in deterministic order with truncation", () => {
  const ids = "zulu bravo alpha lima charlie kilo delta juliet echo india foxtrot hotel".split(" ");
  setReport(
    createPluginLoadResult({
      plugins: ids.map((id) => createPluginRecord({ id, status: "error" })),
    }),
  );
  const spy = spyNotes();
  noteWorkspaceStatus({});
  expect(noteBody(spy, "Plugins")).toBe(
    "Errors: 12\n- alpha\n- bravo\n- charlie\n- delta\n- echo\n- foxtrot\n- hotel\n- india\n- juliet\n- kilo\n- ...",
  );
});

it("collects plugin version drift as structured findings", () => {
  const findings = collectWorkspaceStatusHealthFindings(
    { plugins: { entries: { codex: { enabled: true } } } },
    readiness(codexDrift),
  );
  expect(findings).toEqual([
    expect.objectContaining({
      checkId: "core/doctor/workspace-status",
      severity: "warning",
      path: "plugins.entries.codex",
      target: "codex",
      requirement: "plugin-version-drift",
      message: expect.stringContaining("2026.5.30-beta.1"),
      fixHint: expect.stringContaining("openclaw plugins update codex"),
    }),
  ]);
});

it("reports npm target lookup failure without an uninstallable fix hint", () => {
  const findings = collectWorkspaceStatusHealthFindings(
    { plugins: { entries: { brave: { enabled: true } } } },
    readiness({
      pluginId: "brave",
      installedVersion: "2026.7.1-beta.2",
      gatewayVersion: "2026.7.1-2",
      source: "npm",
      packageName: "@openclaw/brave-plugin",
      spec: "@openclaw/brave-plugin@2026.7.1-beta.2",
      targetResolution: {
        status: "unresolved",
        packageName: "@openclaw/brave-plugin",
        requestedTarget: "2026.7.1",
        error: "npm registry did not resolve @openclaw/brave-plugin@2026.7.1: HTTP 404",
      },
    }),
  );
  expect(findings).toEqual([
    expect.objectContaining({
      severity: "warning",
      message: expect.stringContaining("Repair target resolution failed"),
      fixHint: expect.stringContaining("No install command generated"),
    }),
  ]);
  expect(findings[0]?.fixHint).not.toContain("openclaw plugins update");
  expect(findings[0]?.fixHint).not.toContain("openclaw gateway restart");
});

it("collects compatibility warnings and plugin diagnostics", () => {
  setReport(
    createPluginLoadResult({
      plugins: [],
      diagnostics: [
        {
          level: "error",
          pluginId: "broken-plugin",
          message: "channel setup failed",
          source: "/tmp/plugin.json",
          code: "channel-setup-failure",
        },
        { level: "info", pluginId: "selected", message: "explicit plugin source selected" },
      ],
    }),
    ["legacy-plugin is hook-only"],
  );
  expect(collectWorkspaceStatusHealthFindings({})).toEqual([
    expect.objectContaining({
      checkId: "core/doctor/workspace-status",
      severity: "warning",
      path: "plugins",
      requirement: "plugin-compatibility",
      message: "legacy-plugin is hook-only",
    }),
    expect.objectContaining({
      checkId: "core/doctor/workspace-status",
      severity: "error",
      path: "plugins.entries.broken-plugin",
      target: "broken-plugin",
      requirement: "channel-setup-failure",
      source: "/tmp/plugin.json",
      message: "channel setup failed",
    }),
    expect.objectContaining({
      severity: "info",
      target: "selected",
      message: "explicit plugin source selected",
    }),
  ]);
});

it("surfaces active official managed plugin version drift", () => {
  const body = showDrift(codexDrift);
  for (const text of [
    "1 active official plugin not on post-restart OpenClaw 2026.6.1",
    "codex: 2026.5.30-beta.1 (npm) -> expected 2026.6.1",
    "openclaw plugins update codex",
    "openclaw gateway restart",
  ]) {
    expect(body).toContain(text);
  }
});

it("uses package-version update commands for exact npm plugin drift", () => {
  const body = showDrift({
    pluginId: "brave",
    installedVersion: "2026.6.9",
    gatewayVersion: "2026.6.10-beta.1",
    source: "npm",
    packageName: "@openclaw/brave-plugin",
    spec: "@openclaw/brave-plugin@2026.6.9",
    targetResolution: {
      status: "resolved",
      packageName: "@openclaw/brave-plugin",
      requestedTarget: "2026.6.10-beta.1",
      version: "2026.6.10-beta.1",
    },
  });
  expect(body).toContain("openclaw plugins update @openclaw/brave-plugin@2026.6.10-beta.1");
  expect(body).not.toContain("openclaw plugins update brave");
  expect(body).toContain("openclaw gateway restart");
});
