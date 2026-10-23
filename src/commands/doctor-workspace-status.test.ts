// Doctor workspace status tests cover workspace inspection and status output.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshotScopeRunner } from "../plugins/current-plugin-metadata-snapshot.js";
import { createPluginLoadResult, createPluginRecord } from "../plugins/status.test-fixtures.js";
import { collectWorkspaceStatusHealthFindings } from "./doctor-workspace-status.js";

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

describe("collectWorkspaceStatusHealthFindings", () => {
  it("shares scoped workspace inspection while reporting identical registrar failures once", () => {
    const diagnostic = {
      level: "error" as const,
      pluginId: "broken-fixture",
      source: "/plugins/broken-fixture/index.js",
      message: "board widget registration has invalid kind",
    };
    mocks.listAgentIds.mockReturnValue(["alpha", "beta"]);
    mocks.resolveAgentWorkspaceDir.mockImplementation((_cfg, agentId) => `/workspace/${agentId}`);
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

    const findings = collectWorkspaceStatusHealthFindings({}, { runWithPluginMetadataSnapshot });
    expect(findings.map((finding) => finding.message)).toEqual([
      'Agent "alpha": legacy-plugin is hook-only',
      'Agent "alpha": board widget registration has invalid kind',
      'Agent "beta": legacy-plugin is hook-only',
    ]);
    expect(findings.filter((finding) => finding.target === "broken-fixture")).toHaveLength(1);
    expect(activeWorkspace).toBeUndefined();
  });

  it("shares scoped workspace inspection while reporting identical registrar failures once", () => {
    const diagnostic = {
      level: "error" as const,
      pluginId: "broken-fixture",
      source: "/plugins/broken-fixture/index.js",
      message: "board widget registration has invalid kind",
    };
    mocks.listAgentIds.mockReturnValue(["alpha", "beta"]);
    mocks.resolveAgentWorkspaceDir.mockImplementation((_cfg, agentId) => `/workspace/${agentId}`);
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

    const findings = collectWorkspaceStatusHealthFindings({}, { runWithPluginMetadataSnapshot });
    expect(findings.map((finding) => finding.message)).toEqual([
      'Agent "alpha": legacy-plugin is hook-only',
      'Agent "alpha": board widget registration has invalid kind',
      'Agent "beta": legacy-plugin is hook-only',
    ]);
    expect(findings.filter((finding) => finding.target === "broken-fixture")).toHaveLength(1);
    expect(activeWorkspace).toBeUndefined();
  });

  it("omits healthy plugins but gives errored metadata records an actionable finding", () => {
    mocks.listAgentIds.mockReturnValue(["default"]);
    mocks.resolveAgentWorkspaceDir.mockReturnValue("/workspace");
    mocks.buildPluginRegistrySnapshotReport.mockReturnValue({
      workspaceDir: "/workspace",
      ...createPluginLoadResult({
        plugins: [
          createPluginRecord({ id: "healthy" }),
          createPluginRecord({ id: "broken", status: "error", error: "manifest invalid" }),
        ],
      }),
    });
    mocks.buildPluginCompatibilityWarnings.mockReturnValue([]);
    expect(collectWorkspaceStatusHealthFindings({})).toEqual([
      expect.objectContaining({
        target: "broken",
        category: "fix-now",
        fixHint: expect.stringContaining("openclaw plugins inspect broken --runtime"),
      }),
    ]);
  });

  it("collects plugin version drift as structured findings", async () => {
    mocks.resolveAgentWorkspaceDir.mockReturnValue("/workspace");
    mocks.buildPluginRegistrySnapshotReport.mockReturnValue({
      workspaceDir: "/workspace",
      ...createPluginLoadResult({ plugins: [] }),
    });
    mocks.buildPluginCompatibilityWarnings.mockReturnValue([]);

    const findings = collectWorkspaceStatusHealthFindings(
      {
        plugins: { entries: { codex: { enabled: true } } },
      },
      {
        pluginVersionReadiness: {
          status: "resolved",
          report: {
            gatewayVersion: "2026.6.1",
            drifts: [
              {
                pluginId: "codex",
                installedVersion: "2026.5.30-beta.1",
                gatewayVersion: "2026.6.1",
                source: "npm",
              },
            ],
          },
        },
      },
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
    mocks.resolveAgentWorkspaceDir.mockReturnValue("/workspace");
    mocks.buildPluginRegistrySnapshotReport.mockReturnValue({
      workspaceDir: "/workspace",
      ...createPluginLoadResult({ plugins: [] }),
    });
    mocks.buildPluginCompatibilityWarnings.mockReturnValue([]);

    const findings = collectWorkspaceStatusHealthFindings(
      { plugins: { entries: { brave: { enabled: true } } } },
      {
        pluginVersionReadiness: {
          status: "resolved",
          report: {
            gatewayVersion: "2026.7.1-2",
            drifts: [
              {
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
              },
            ],
          },
        },
      },
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

  it("collects compatibility warnings and plugin diagnostics", async () => {
    mocks.resolveAgentWorkspaceDir.mockReturnValue("/workspace");
    mocks.buildPluginRegistrySnapshotReport.mockReturnValue({
      workspaceDir: "/workspace",
      ...createPluginLoadResult({
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
    });
    mocks.buildPluginCompatibilityWarnings.mockReturnValue(["legacy-plugin is hook-only"]);
    const findings = collectWorkspaceStatusHealthFindings({});

    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/workspace-status",
        severity: "warning",
        path: "plugins",
        requirement: "plugin-compatibility",
        category: "recommended",
        message: "legacy-plugin is hook-only",
      }),
      expect.objectContaining({
        checkId: "core/doctor/workspace-status",
        severity: "error",
        path: "plugins.entries.broken-plugin",
        target: "broken-plugin",
        requirement: "channel-setup-failure",
        category: "fix-now",
        fixHint: expect.stringContaining("openclaw plugins inspect broken-plugin --runtime"),
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

  it("labels workspace diagnostics for the affected secondary agent", () => {
    mocks.buildPluginRegistrySnapshotReport.mockClear();
    mocks.listAgentIds.mockReturnValue(["default", "secondary"]);
    mocks.resolveAgentWorkspaceDir.mockImplementation((_cfg, agentId) => `/${agentId}`);
    mocks.buildPluginRegistrySnapshotReport.mockImplementation(({ workspaceDir }) => ({
      workspaceDir,
      ...createPluginLoadResult({
        plugins: [],
        diagnostics:
          workspaceDir === "/secondary"
            ? [{ level: "error", pluginId: "broken", message: "load failed" }]
            : [],
      }),
    }));
    mocks.buildPluginCompatibilityWarnings.mockReturnValue([]);

    const findings = collectWorkspaceStatusHealthFindings({});

    expect(mocks.buildPluginRegistrySnapshotReport).toHaveBeenCalledTimes(2);
    expect(findings).toEqual([
      expect.objectContaining({
        message: 'Agent "secondary": load failed',
        path: "plugins.entries.broken",
      }),
    ]);
  });
});
