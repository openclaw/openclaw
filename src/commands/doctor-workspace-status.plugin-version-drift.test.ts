import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as noteModule from "../../packages/terminal-core/src/note.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { fetchClawHubPackageDetail } from "../infra/clawhub-packages.js";
import type { PluginMetadataSnapshotScopeRunner } from "../plugins/current-plugin-metadata-snapshot.js";
import {
  detectPluginVersionDrift,
  resolvePluginVersionDriftTargets,
  type PluginVersionDriftReport,
  type PluginVersionRestartReadiness,
} from "../plugins/plugin-version-drift.js";
import { createPluginLoadResult, createPluginRecord } from "../plugins/status.test-fixtures.js";
import {
  collectWorkspaceStatusHealthFindings,
  noteWorkspaceStatus,
} from "./doctor-workspace-status.js";

vi.mock("../infra/clawhub-packages.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/clawhub-packages.js")>()),
  fetchClawHubPackageDetail: vi.fn(),
}));
const mocks = vi.hoisted(() => ({
  listAgentIds: vi.fn<(_cfg: OpenClawConfig) => string[]>(() => ["default"]),
  resolveAgentWorkspaceDir: vi.fn(),
  buildPluginRegistrySnapshotReport: vi.fn(),
  buildPluginCompatibilityWarnings: vi.fn(),
}));
vi.mock("../agents/agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/agent-scope.js")>()),
  listAgentIds: mocks.listAgentIds,
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
}));
vi.mock("../plugins/status.js", () => ({
  buildPluginRegistrySnapshotReport: mocks.buildPluginRegistrySnapshotReport,
  buildPluginCompatibilityWarnings: mocks.buildPluginCompatibilityWarnings,
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
  mocks.buildPluginCompatibilityWarnings.mockImplementation(({ config, workspaceDir, report }) => {
    expect(activeWorkspace).toBe(workspaceDir);
    expect(config).toEqual({});
    expect(report).toEqual({
      workspaceDir,
      ...createPluginLoadResult({ plugins: [], diagnostics: [diagnostic] }),
    });
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
  const { findings, output } = inspect(readiness(codexDrift).pluginVersionReadiness);
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
  for (const text of [
    "1 active official plugin not on post-restart OpenClaw 2026.6.1",
    "codex: 2026.5.30-beta.1 (npm) -> expected 2026.6.1",
    "openclaw plugins update codex",
    "openclaw gateway restart",
  ]) {
    expect(output).toContain(text);
  }
});

const driftConfig: OpenClawConfig = { plugins: { entries: { codex: { enabled: true } } } };
function inspect(state: PluginVersionRestartReadiness, cfg: OpenClawConfig = driftConfig) {
  mocks.listAgentIds.mockReturnValue([]);
  for (const inspectWorkspace of [
    mocks.resolveAgentWorkspaceDir,
    mocks.buildPluginRegistrySnapshotReport,
    mocks.buildPluginCompatibilityWarnings,
  ]) {
    inspectWorkspace.mockImplementation(() => {
      throw new Error("plugin drift evidence must not inspect agent workspaces");
    });
  }
  const findings = collectWorkspaceStatusHealthFindings(cfg, { pluginVersionReadiness: state });
  const noteSpy = vi.spyOn(noteModule, "note").mockImplementation(() => {});
  noteSpy.mockClear();
  noteWorkspaceStatus(cfg, { pluginVersionReadiness: state });
  return { findings, output: noteBody(noteSpy, "Plugin restart readiness") };
}

function detectCodexDrift(installedVersion: string, gatewayVersion: string) {
  const report = detectPluginVersionDrift({
    gatewayVersion,
    installRecords: {
      codex: {
        source: "npm",
        spec: `@openclaw/codex@${installedVersion}`,
        resolvedName: "@openclaw/codex",
        resolvedVersion: installedVersion,
      },
    },
    config: driftConfig,
  });
  for (const entry of report.drifts) {
    entry.targetResolution = {
      status: "resolved",
      packageName: "@openclaw/codex",
      requestedTarget: gatewayVersion,
      version: gatewayVersion,
    };
  }
  return report;
}

it.each(["unresolved", "restart"] as const)("reports %s Gateway readiness", (state) => {
  const unresolved = state === "unresolved";
  const runningGatewayVersion = "2026.5.30";
  const { findings, output } = inspect(
    unresolved
      ? {
          status: "unresolved",
          reason: "Gateway service package version is unavailable.",
          runningGatewayVersion,
        }
      : {
          status: "resolved",
          runningGatewayVersion,
          report: detectCodexDrift("2026.6.1", "2026.6.1"),
        },
  );
  expect(findings).toMatchObject([
    {
      requirement: `plugin-version-${unresolved ? "restart-readiness" : "gateway-restart"}`,
      message: expect.stringContaining(
        unresolved
          ? "Gateway service package version is unavailable"
          : `running Gateway is ${runningGatewayVersion}`,
      ),
      ...(!unresolved ? { fixHint: "openclaw gateway restart" } : {}),
    },
  ]);
  expect(output).toContain(`Running Gateway: OpenClaw ${runningGatewayVersion}`);
});

it("reports older and newer pins as advisory drift while accepting correction suffixes", () => {
  const gatewayVersion = "2026.6.1";

  for (const installedVersion of ["2026.5.30", "2026.6.2"]) {
    const report = detectCodexDrift(installedVersion, gatewayVersion);
    const { findings, output } = inspect({ status: "resolved", report });
    expect(findings).toEqual([
      {
        checkId: "core/doctor/workspace-status",
        severity: "warning",
        message: `Plugin codex is ${installedVersion}, but a Gateway restart will load OpenClaw ${gatewayVersion}. The confirmed plugin target is ${gatewayVersion}.`,
        path: "plugins.entries.codex",
        target: "codex",
        requirement: "plugin-version-drift",
        fixHint: "openclaw plugins update @openclaw/codex@2026.6.1 && openclaw gateway restart",
      },
    ]);

    for (const text of [
      `1 active official plugin not on post-restart OpenClaw ${gatewayVersion}`,
      `codex: ${installedVersion} (npm) -> expected ${gatewayVersion}`,
      "openclaw plugins update @openclaw/codex@2026.6.1",
      "openclaw gateway restart",
    ]) {
      expect(output).toContain(text);
    }
    expect(output).not.toContain("openclaw plugins update codex");
  }

  for (const [installedVersion, correctionGatewayVersion] of [
    ["2026.6.1", "2026.6.1-1"],
    ["2026.6.1-1", "2026.6.1"],
  ] as const) {
    const report = detectCodexDrift(installedVersion, correctionGatewayVersion);
    expect(report.drifts).toEqual([]);
    expect(
      collectWorkspaceStatusHealthFindings(driftConfig, {
        pluginVersionReadiness: {
          status: "resolved",
          report,
          runningGatewayVersion: installedVersion,
        },
      }),
    ).toEqual([]);
  }
});

it.each([
  ["resolved", "2026.9.2", ">=2026.9.3", "2026.9.3"],
  ["current", "2026.9.3", ">=2026.9.3", "2026.9.3"],
  ["unresolved", "2026.9.3", ">=2026.10.1", "2026.9.3"],
  ["resolved", "2026.9.3", ">=2026.9.3", "2026.9.3-1"],
])(
  "renders %s ClawHub targets consistently (%s, %s, %s)",
  async (result, installedVersion, pluginApiRange, latestVersion) => {
    vi.mocked(fetchClawHubPackageDetail).mockResolvedValueOnce({
      package: {
        name: "@openclaw/whatsapp",
        displayName: "WhatsApp",
        family: "code-plugin",
        channel: "official",
        isOfficial: true,
        createdAt: 0,
        updatedAt: 0,
        latestVersion,
        compatibility: { pluginApiRange },
      },
    });
    const report = await resolvePluginVersionDriftTargets(
      detectPluginVersionDrift({
        gatewayVersion: "2026.9.4",
        installRecords: {
          whatsapp: {
            source: "clawhub",
            spec: "clawhub:@openclaw/whatsapp",
            clawhubPackage: "@openclaw/whatsapp",
            resolvedVersion: installedVersion,
          },
        },
      }),
    );
    const { findings, output } = inspect({ status: "resolved", report }, {});
    expect(findings).toHaveLength(1);
    if (result === "current") {
      expect(findings[0]?.severity).toBe("info");
      expect(findings[0]?.message).toContain("registry version 2026.9.3");
      expect(findings[0]?.message).toContain("No plugin update can reach 2026.9.4");
      expect(findings[0]?.fixHint).toBeUndefined();
      expect(output).toContain("already holds registry version 2026.9.3");
      expect(output).toContain("whatsapp: 2026.9.3 (clawhub) -> expected 2026.9.4");
      expect(output).not.toContain("openclaw plugins update");
      expect(output).not.toContain("No install command generated");
    } else if (result === "resolved") {
      expect(findings[0]?.message).toContain(`confirmed plugin target is ${latestVersion}`);
      expect(output).toContain(
        `whatsapp: ${installedVersion} (clawhub) -> expected ${latestVersion}`,
      );
      expect(output).not.toContain("expected 2026.9.4");
      expect(findings[0]?.fixHint).toBe(
        "openclaw plugins update whatsapp && openclaw gateway restart",
      );
      expect(output).toContain(findings[0]?.fixHint);
    } else {
      expect(findings[0]?.message).toContain("requires plugin API >=2026.10.1");
      expect(output).toContain("requires plugin API >=2026.10.1");
      expect(output).toContain("No install command generated");
      expect(output).not.toContain("openclaw plugins update");
      expect(findings[0]?.fixHint).not.toContain("openclaw plugins update");
    }
  },
);
