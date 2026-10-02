// Doctor workspace status tests cover workspace inspection and status output.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
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
  resolveDefaultAgentId: vi.fn(),
  buildPluginRegistrySnapshotReport: vi.fn(),
  buildPluginCompatibilityWarnings: vi.fn(),
}));

vi.mock("../agents/agent-scope.js", () => ({
  listAgentIds: (cfg: OpenClawConfig) => mocks.listAgentIds(cfg),
  resolveAgentWorkspaceDir: (...args: unknown[]) => mocks.resolveAgentWorkspaceDir(...args),
  tryResolveDefaultAgentId: (...args: unknown[]) => mocks.resolveDefaultAgentId(...args),
}));

vi.mock("../plugins/status.js", () => ({
  buildPluginRegistrySnapshotReport: (...args: unknown[]) =>
    mocks.buildPluginRegistrySnapshotReport(...args),
  buildPluginCompatibilityWarnings: (...args: unknown[]) =>
    mocks.buildPluginCompatibilityWarnings(...args),
}));

async function runNoteWorkspaceStatusForTest(
  loadResult: ReturnType<typeof createPluginLoadResult>,
  compatibilityWarnings: string[] = [],
  opts?: {
    cfg?: OpenClawConfig;
    pluginVersionDrift?: PluginVersionDriftReport;
  },
) {
  const cfg: OpenClawConfig = opts?.cfg ?? {};
  mocks.resolveDefaultAgentId.mockReturnValue("default");
  mocks.listAgentIds.mockReturnValue(["default"]);
  mocks.resolveAgentWorkspaceDir.mockReturnValue("/workspace");
  mocks.buildPluginRegistrySnapshotReport.mockReturnValue({
    workspaceDir: "/workspace",
    ...loadResult,
  });
  mocks.buildPluginCompatibilityWarnings.mockReturnValue(compatibilityWarnings);

  const noteSpy = vi.spyOn(noteModule, "note").mockImplementation(() => {});
  noteWorkspaceStatus(cfg, {
    pluginVersionReadiness: opts?.pluginVersionDrift
      ? { status: "resolved", report: opts.pluginVersionDrift }
      : undefined,
  });
  return noteSpy;
}

describe("noteWorkspaceStatus", () => {
  it("shares scoped workspace inspection while reporting identical registrar failures once", () => {
    const diagnostic = {
      level: "error" as const,
      pluginId: "broken-fixture",
      source: "/plugins/broken-fixture/index.js",
      message: "board widget registration has invalid kind",
    };
    mocks.resolveDefaultAgentId.mockReturnValue("beta");
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

    const noteSpy = vi.spyOn(noteModule, "note").mockImplementation(() => {
      expect(activeWorkspace).toBeDefined();
    });
    try {
      expect(noteWorkspaceStatus({}, { runWithPluginMetadataSnapshot })).toEqual({
        workspaceDir: "/workspace/beta",
      });
      expect(noteSpy.mock.calls).toEqual([
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
    } finally {
      noteSpy.mockRestore();
    }
  });

  it("omits healthy plugin inventory", async () => {
    const noteSpy = await runNoteWorkspaceStatusForTest(
      createPluginLoadResult({
        plugins: [
          createPluginRecord({
            id: "claude-bundle",
            name: "Claude Bundle",
            source: "/tmp/claude-bundle",
            format: "bundle",
            bundleFormat: "claude",
            bundleCapabilities: ["skills", "commands", "agents"],
          }),
        ],
      }),
    );
    try {
      expect(noteSpy).not.toHaveBeenCalled();
    } finally {
      noteSpy.mockRestore();
    }
  });

  it("lists only errored plugin ids in deterministic order with truncation", async () => {
    const pluginIds = [
      "zulu",
      "bravo",
      "alpha",
      "lima",
      "charlie",
      "kilo",
      "delta",
      "juliet",
      "echo",
      "india",
      "foxtrot",
      "hotel",
    ];
    const noteSpy = await runNoteWorkspaceStatusForTest(
      createPluginLoadResult({
        plugins: pluginIds.map((id) => createPluginRecord({ id, status: "error" })),
      }),
    );
    try {
      const pluginCalls = noteSpy.mock.calls.filter(([, title]) => title === "Plugins");
      expect(pluginCalls).toHaveLength(1);
      const [body] = expectDefined(pluginCalls[0], "(pluginCalls)[0] test invariant");
      expect(body).toBe(
        [
          "Errors: 12",
          "- alpha",
          "- bravo",
          "- charlie",
          "- delta",
          "- echo",
          "- foxtrot",
          "- hotel",
          "- india",
          "- juliet",
          "- kilo",
          "- ...",
        ].join("\n"),
      );
    } finally {
      noteSpy.mockRestore();
    }
  });

  it("collects plugin version drift as structured findings", async () => {
    mocks.resolveDefaultAgentId.mockReturnValue("default");
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
    mocks.resolveDefaultAgentId.mockReturnValue("default");
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
    mocks.resolveDefaultAgentId.mockReturnValue("default");
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

  it("surfaces active official managed plugin version drift", async () => {
    const noteSpy = await runNoteWorkspaceStatusForTest(
      createPluginLoadResult({
        plugins: [
          createPluginRecord({
            id: "codex",
            name: "Codex",
            origin: "global",
            source: "/tmp/codex/index.js",
          }),
        ],
      }),
      [],
      {
        cfg: {
          plugins: {
            entries: {
              codex: { enabled: true },
            },
          },
        },
        pluginVersionDrift: {
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
    );
    try {
      const driftCalls = noteSpy.mock.calls.filter(
        ([, title]) => title === "Plugin restart readiness",
      );
      expect(driftCalls).toHaveLength(1);
      const [body] = expectDefined(driftCalls[0], "(driftCalls)[0] test invariant");
      expect(body).toContain("1 active official plugin not on post-restart OpenClaw 2026.6.1");
      expect(body).toContain("codex: 2026.5.30-beta.1 (npm) -> expected 2026.6.1");
      expect(body).toContain("openclaw plugins update codex");
      expect(body).toContain("openclaw gateway restart");
    } finally {
      noteSpy.mockRestore();
    }
  });

  it("uses package-version update commands for exact npm plugin drift", async () => {
    const noteSpy = await runNoteWorkspaceStatusForTest(
      createPluginLoadResult({
        plugins: [
          createPluginRecord({
            id: "brave",
            name: "Brave",
            origin: "global",
            source: "/tmp/brave/index.js",
          }),
        ],
      }),
      [],
      {
        cfg: {
          plugins: {
            entries: {
              brave: { enabled: true },
            },
          },
        },
        pluginVersionDrift: {
          gatewayVersion: "2026.6.10-beta.1",
          drifts: [
            {
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
            },
          ],
        },
      },
    );
    try {
      const driftCalls = noteSpy.mock.calls.filter(
        ([, title]) => title === "Plugin restart readiness",
      );
      expect(driftCalls).toHaveLength(1);
      const [body] = expectDefined(driftCalls[0], "(driftCalls)[0] test invariant");
      expect(body).toContain("openclaw plugins update @openclaw/brave-plugin@2026.6.10-beta.1");
      expect(body).not.toContain("openclaw plugins update brave");
      expect(body).toContain("openclaw gateway restart");
    } finally {
      noteSpy.mockRestore();
    }
  });

  it("passes the shared status report into compatibility warnings", async () => {
    const loadResult = createPluginLoadResult({
      plugins: [
        createPluginRecord({
          id: "legacy-plugin",
          name: "Legacy Plugin",
          hookCount: 1,
        }),
      ],
      typedHooks: [createTypedHook({ pluginId: "legacy-plugin", hookName: "before_prompt_build" })],
    });
    const noteSpy = await runNoteWorkspaceStatusForTest(loadResult, ["legacy-plugin is hook-only"]);
    try {
      expect(mocks.buildPluginRegistrySnapshotReport).toHaveBeenCalledWith({
        config: {},
        workspaceDir: "/workspace",
      });
      expect(mocks.buildPluginCompatibilityWarnings).toHaveBeenCalledWith({
        config: {},
        workspaceDir: "/workspace",
        report: {
          workspaceDir: "/workspace",
          ...loadResult,
        },
      });
      const compatibilityCalls = noteSpy.mock.calls.filter(
        ([, title]) => title === "Plugin compatibility",
      );
      expect(compatibilityCalls).toHaveLength(1);
      const [body] = expectDefined(compatibilityCalls[0], "(compatibilityCalls)[0] test invariant");
      expect(body).toContain("legacy-plugin is hook-only");
    } finally {
      noteSpy.mockRestore();
    }
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
