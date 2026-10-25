import { beforeEach, describe, expect, it, vi } from "vitest";
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
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.listAgentIds.mockReturnValue(["default"]);
    mocks.resolveAgentWorkspaceDir.mockReturnValue("/workspace");
    mocks.buildPluginRegistrySnapshotReport.mockReturnValue({
      workspaceDir: "/workspace",
      ...createPluginLoadResult({ plugins: [] }),
    });
    mocks.buildPluginCompatibilityWarnings.mockReturnValue([]);
  });
  it("shares scoped workspace inspection while reporting identical registrar failures once", () => {
    const diagnostic = {
      level: "error" as const,
      pluginId: "broken-fixture",
      source: "/plugins/broken-fixture/index.js",
      message: "board widget registration has invalid kind",
      code: "channel-setup-failure",
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
        ...createPluginLoadResult({
          plugins: [],
          diagnostics: [
            diagnostic,
            ...(workspaceDir === "/workspace/beta"
              ? [
                  { level: "error" as const, pluginId: "secondary", message: "load failed" },
                  {
                    level: "info" as const,
                    pluginId: "selected",
                    message: "explicit plugin source selected",
                  },
                ]
              : []),
          ],
        }),
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
      'Agent "beta": load failed',
      'Agent "beta": explicit plugin source selected',
    ]);
    expect(findings.filter((finding) => finding.target === "broken-fixture")).toHaveLength(1);
    expect(findings).toMatchObject([
      {
        checkId: "core/doctor/workspace-status",
        severity: "warning",
        path: "plugins",
        requirement: "plugin-compatibility",
        category: "recommended",
      },
      {
        checkId: "core/doctor/workspace-status",
        severity: "error",
        path: "plugins.entries.broken-fixture",
        requirement: "channel-setup-failure",
        category: "fix-now",
        source: diagnostic.source,
        fixHint: expect.stringContaining("openclaw plugins inspect broken-fixture --runtime"),
      },
      { severity: "warning" },
      { path: "plugins.entries.secondary" },
      { severity: "info", target: "selected" },
    ]);
    expect(activeWorkspace).toBeUndefined();
  });

  it("omits healthy plugins but gives errored metadata records an actionable finding", () => {
    mocks.buildPluginRegistrySnapshotReport.mockReturnValue({
      workspaceDir: "/workspace",
      ...createPluginLoadResult({
        plugins: [
          createPluginRecord({ id: "healthy" }),
          createPluginRecord({ id: "broken", status: "error", error: "manifest invalid" }),
        ],
      }),
    });
    expect(collectWorkspaceStatusHealthFindings({})).toEqual([
      expect.objectContaining({
        target: "broken",
        message: "manifest invalid",
        category: "fix-now",
        fixHint: expect.stringContaining("openclaw plugins inspect broken --runtime"),
      }),
    ]);
  });

  it.each([false, true])(
    "reports plugin drift with an actionable hint (unresolved: %s)",
    (unresolved) => {
      const pluginId = "codex";
      const findings = collectWorkspaceStatusHealthFindings(
        { plugins: { entries: { [pluginId]: { enabled: true } } } },
        {
          pluginVersionReadiness: {
            status: "resolved",
            report: {
              gatewayVersion: "2026.6.1",
              drifts: [
                {
                  pluginId,
                  installedVersion: "2026.5.30-beta.1",
                  gatewayVersion: "2026.6.1",
                  source: "npm",
                  ...(unresolved
                    ? ({
                        packageName: "@openclaw/codex",
                        targetResolution: {
                          status: "unresolved",
                          packageName: "@openclaw/codex",
                          requestedTarget: "2026.6.1",
                          error: "HTTP 404",
                        },
                      } as const)
                    : {}),
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
          target: pluginId,
          requirement: "plugin-version-drift",
          message: expect.stringContaining(
            unresolved ? "Repair target resolution failed" : "2026.5.30-beta.1",
          ),
          fixHint: expect.stringContaining(
            unresolved ? "No install command generated" : "openclaw plugins update codex",
          ),
        }),
      ]);
      if (unresolved) {
        expect(findings[0]?.fixHint).not.toContain("openclaw plugins update");
        expect(findings[0]?.fixHint).not.toContain("openclaw gateway restart");
      }
    },
  );
});
