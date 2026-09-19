// Status-all report data tests cover local read-only diagnosis probes.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { RestartSentinelPayload } from "../../infra/restart-sentinel.js";
import type { UpdateRunRecord } from "../../infra/update-run-record.js";
import { writeSkill } from "../../skills/test-support/e2e-test-helpers.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { baseStatusGatewaySnapshot, baseStatusOverviewSurface } from "../status.test-support.ts";

const mocks = vi.hoisted(() => ({
  listUpdateRuns: vi.fn<() => UpdateRunRecord[]>(() => []),
  findActiveUpdateRun: vi.fn<() => UpdateRunRecord | undefined>(),
  getUpdateRun: vi.fn<(runId: string) => UpdateRunRecord | undefined>(),
  readRestartSentinelReadOnly: vi.fn<() => Promise<{ payload: RestartSentinelPayload } | null>>(
    async () => null,
  ),
  buildStatusAllOverviewRows: vi.fn<
    typeof import("../status-overview-rows.ts").buildStatusAllOverviewRows
  >(() => []),
  readConfigFileSnapshot: vi.fn(async () => ({ path: "/tmp/openclaw.json" })),
  inspectPortUsage: vi.fn(async () => null),
  resolveGatewayBindHost: vi.fn(async () => "127.0.0.1"),
  resolveStatusGatewayDiagnosticsSafe: vi.fn(async () => ({ ok: true, value: {} })),
  resolveStatusGatewayHealthSafe: vi.fn(async () => undefined),
  resolveNodeExecEligibility: vi.fn(() => ({ canExec: false })),
  loadExecApprovalsReadOnly: vi.fn(() => ({ version: 1, agents: {} })),
  buildWorkspaceSkillReadiness: vi.fn<
    typeof import("../../skills/discovery/status.js").buildWorkspaceSkillReadiness
  >(() => ({ workspaceDir: "/tmp/mock-skills", eligible: 0, missing: 0 })),
  resolveStatusSummaryFromOverview: vi.fn(async () => ({})),
}));

vi.mock("../../agents/exec-defaults.js", () => ({
  resolveNodeExecEligibility: mocks.resolveNodeExecEligibility,
}));
vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
  resolveGatewayPort: () => 18789,
}));
vi.mock("../../daemon/diagnostics.js", () => ({
  readLastGatewayErrorLine: async () => null,
}));
vi.mock("../../gateway/net.js", () => ({
  resolveGatewayBindHost: mocks.resolveGatewayBindHost,
  resolveGatewayRequiredListenHosts: (bindHost: string) =>
    bindHost === "100.64.0.40" ? [bindHost, "127.0.0.1"] : [bindHost],
}));
vi.mock("../../infra/ports-inspect.js", () => ({ inspectPortUsage: mocks.inspectPortUsage }));
vi.mock("../../infra/exec-approvals.js", () => ({
  loadExecApprovalsReadOnly: mocks.loadExecApprovalsReadOnly,
}));
vi.mock("../../infra/update-run-ledger.js", () => ({
  findActiveUpdateRun: mocks.findActiveUpdateRun,
  getUpdateRun: mocks.getUpdateRun,
  listUpdateRuns: mocks.listUpdateRuns,
  reconcileAbandonedUpdateRuns: () => [],
}));
vi.mock("../../infra/restart-sentinel.js", () => ({
  readRestartSentinelReadOnly: mocks.readRestartSentinelReadOnly,
}));
vi.mock("../../plugins/status.js", () => ({
  buildPluginCompatibilityNotices: () => [],
  withPluginDiagnosticsReport: async <T>(
    _params: unknown,
    consume: (report: object) => T | Promise<T>,
  ) => consume({}),
}));
vi.mock("../../skills/discovery/status.js", () => ({
  buildWorkspaceSkillReadiness: mocks.buildWorkspaceSkillReadiness,
}));
vi.mock("../../skills/runtime/remote.js", () => ({ getRemoteSkillEligibility: () => ({}) }));
vi.mock("../status-overview-rows.ts", () => ({
  buildStatusAllOverviewRows: mocks.buildStatusAllOverviewRows,
}));
vi.mock("../status-runtime-shared.ts", () => ({
  resolveStatusGatewayDiagnosticsSafe: mocks.resolveStatusGatewayDiagnosticsSafe,
  resolveStatusGatewayHealthSafe: mocks.resolveStatusGatewayHealthSafe,
}));
vi.mock("../status.gateway-connection.ts", () => ({
  resolveStatusAllConnectionDetails: () => "",
}));
vi.mock("../status.scan-overview.ts", () => ({
  resolveStatusSummaryFromOverview: mocks.resolveStatusSummaryFromOverview,
}));

vi.mock("../../daemon/restart-logs.js", () => ({
  resolveGatewayLogPaths: () => {
    throw new Error("No fixture logs");
  },
  resolveGatewaySupervisorLogPaths: () => {
    throw new Error("No fixture logs");
  },
  resolveGatewayRestartLogPath: () => "/tmp/fixture-restart.log",
}));

import { buildStatusAllReportData } from "./report-data.js";
import { buildStatusAllReportLines } from "./report-lines.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("buildStatusAllReportData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildWorkspaceSkillReadiness.mockReset().mockReturnValue({
      workspaceDir: "/tmp/mock-skills",
      eligible: 0,
      missing: 0,
    });
    mocks.listUpdateRuns.mockReturnValue([]);
    mocks.findActiveUpdateRun.mockReturnValue(undefined);
    mocks.getUpdateRun.mockReturnValue(undefined);
    mocks.readRestartSentinelReadOnly.mockResolvedValue(null);
    mocks.resolveStatusGatewayDiagnosticsSafe.mockResolvedValue({ ok: true, value: {} });
    mocks.resolveStatusGatewayHealthSafe.mockResolvedValue(undefined);
  });

  it.each([
    "completed",
    "active",
    "sentinel",
    "none",
    "mixed-sentinel",
    "same-run",
    "different-run",
    "same-prose",
    "generic-sentinel",
  ] as const)(
    "keeps current update availability alongside %s history without observing config",
    async (history) => {
      const rows = await vi.importActual<typeof import("../status-overview-rows.ts")>(
        "../status-overview-rows.ts",
      );
      mocks.buildStatusAllOverviewRows.mockImplementationOnce(rows.buildStatusAllOverviewRows);
      const completed: UpdateRunRecord = {
        runId: "6631ecee-adbf-41e8-a0e3-1b88b28b0a59",
        createdAtMs: 1,
        updatedAtMs: 2,
        trigger: "cli",
        phase: "finished",
        status: "succeeded",
        reason: null,
        origin: {},
        target: {},
        before: { version: "2026.9.1" },
        after: { version: "2026.9.2" },
        steps: [],
        verification: {},
        repair: [],
        confirmedAtMs: null,
        finishedAtMs: 2,
        downtimeMs: null,
      };
      const hasRun = history !== "sentinel" && history !== "none";
      const hasSentinel = [
        "sentinel",
        "mixed-sentinel",
        "same-run",
        "different-run",
        "same-prose",
        "generic-sentinel",
      ].includes(history);
      if (hasRun) {
        mocks.listUpdateRuns.mockReturnValue([completed]);
        mocks.getUpdateRun.mockReturnValue(completed);
      }
      if (history === "active") {
        mocks.findActiveUpdateRun.mockReturnValue({
          ...completed,
          status: "running",
          phase: "verifying",
        });
      }
      if (hasSentinel) {
        const sentinelRunId =
          history === "different-run"
            ? "1e36e13e-8cbf-4c33-bd2b-03adbd8f7a64"
            : history === "same-run"
              ? completed.runId
              : undefined;
        if (sentinelRunId) {
          mocks.getUpdateRun.mockReturnValue({ ...completed, runId: sentinelRunId });
        }
        mocks.readRestartSentinelReadOnly.mockResolvedValue({
          payload: {
            kind: history === "generic-sentinel" ? "restart" : "update",
            status: history === "mixed-sentinel" ? "error" : "ok",
            ts: 3,
            stats: {
              before: completed.before,
              after: completed.after,
              ...(history === "mixed-sentinel" ? { reason: "restart-unhealthy" } : {}),
              ...(sentinelRunId ? { runId: sentinelRunId } : {}),
            },
          },
        });
      }
      const report = await buildStatusAllReportData({
        overview: {
          ...baseStatusOverviewSurface,
          cfg: {},
          update: {
            ...baseStatusOverviewSurface.update,
            registry: { latestVersion: "9999.1.1" },
          },
          gatewaySnapshot: {
            ...baseStatusGatewaySnapshot,
            gatewayReachable: false,
            gatewayProbe: null,
            gatewayCallOverrides: undefined,
            remoteUrlMissing: false,
          },
          secretDiagnostics: [],
          tailscaleMode: "off",
          tailscaleDns: null,
          agentStatus: { agents: [], defaultId: null, totalSessions: 0, bootstrapPendingCount: 0 },
          channels: { rows: [], details: [] },
          channelIssues: [],
          osSummary: { label: "test" },
        } as never,
        daemon: baseStatusOverviewSurface.gatewayService as never,
        nodeService: baseStatusOverviewSurface.nodeService as never,
        nodeOnlyGateway: null,
        progress: { setLabel: vi.fn(), tick: vi.fn() },
      });

      expect(report.overviewRows.find((row) => row.Item === "Update")?.Value).toContain(
        "npm update 9999.1.1",
      );
      expect(report.overviewRows.find((row) => row.Item === "Update")?.Value).toContain("behind 2");
      const success = "✅ OpenClaw updated to 2026.9.2 (from 2026.9.1).";
      expect(
        report.overviewRows.filter((row) => ["Update run", "Update restart"].includes(row.Item)),
      ).toEqual([
        ...(hasRun
          ? [
              {
                Item: "Update run",
                Value:
                  history === "active" ? "⬆️ OpenClaw update in progress: verifying." : success,
              },
            ]
          : []),
        ...(hasSentinel && history !== "same-run" && history !== "generic-sentinel"
          ? [
              {
                Item: "Update restart",
                Value:
                  history === "mixed-sentinel"
                    ? "⚠️ OpenClaw update failed: restart-unhealthy."
                    : success,
              },
            ]
          : []),
      ]);
      expect(mocks.readConfigFileSnapshot).toHaveBeenCalledOnce();
      expect(mocks.readConfigFileSnapshot).toHaveBeenCalledWith({ observe: false });
      expect(mocks.resolveGatewayBindHost).toHaveBeenCalledWith("loopback", undefined);
      expect(mocks.inspectPortUsage).toHaveBeenCalledWith(18789, {
        probeHosts: ["127.0.0.1"],
      });
      expect(mocks.resolveStatusSummaryFromOverview).toHaveBeenCalledOnce();
    },
  );

  it("collects delivery and exporter stability projections in parallel", async () => {
    await buildStatusAllReportData({
      overview: {
        cfg: {},
        gatewaySnapshot: {
          gatewayReachable: true,
          gatewayProbe: { error: null },
          gatewayCallOverrides: undefined,
          gatewayConnection: {},
          remoteUrlMissing: false,
        },
        secretDiagnostics: [],
        tailscaleMode: "off",
        tailscaleDns: null,
        agentStatus: { agents: [], defaultId: null },
        channels: { rows: [], details: [] },
        channelIssues: [],
        runtimeDegradation: { degradedSecretOwners: [], degradedPlugins: [] },
        osSummary: { label: "test" },
      } as never,
      daemon: {} as never,
      nodeService: {} as never,
      nodeOnlyGateway: null,
      progress: { setLabel: vi.fn(), tick: vi.fn() },
    });

    expect(mocks.resolveStatusGatewayDiagnosticsSafe.mock.calls).toEqual([
      [
        expect.objectContaining({
          gatewayReachable: true,
        }),
      ],
      [
        expect.objectContaining({
          gatewayReachable: true,
          type: "telemetry.exporter",
        }),
      ],
    ]);
    expect(mocks.resolveStatusSummaryFromOverview).not.toHaveBeenCalled();
  });

  it("renders the system agent's unfiltered readiness and refreshes newly installed binaries", async () => {
    const rootDir = tempDirs.make("openclaw-status-readiness-");
    const workspaceDir = path.join(rootDir, "beta");
    const bundledDir = path.join(rootDir, "bundled");
    const binDir = path.join(rootDir, "bin");
    await fs.mkdir(binDir);
    const missingBin = "openclaw-readiness-fixture-bin";
    for (const name of [
      "ready",
      "missing",
      "disabled",
      "always",
      "agent-excluded",
      "unsupported-os",
      "blocked",
    ]) {
      await writeSkill({
        dir: path.join(name === "blocked" ? bundledDir : path.join(workspaceDir, "skills"), name),
        name,
        description: "Synthetic status readiness fixture",
        metadata: JSON.stringify({
          openclaw: {
            always: name === "always",
            requires: {
              bins: ["missing", "disabled", "always"].includes(name) ? [missingBin] : [],
            },
            ...(name === "unsupported-os" ? { os: ["openclaw-fixture-unsupported"] } : {}),
          },
        }),
      });
    }
    const actual = await vi.importActual<typeof import("../../skills/discovery/status.js")>(
      "../../skills/discovery/status.js",
    );
    mocks.buildWorkspaceSkillReadiness.mockImplementation(actual.buildWorkspaceSkillReadiness);
    const params = {
      overview: {
        cfg: {
          plugins: { enabled: false },
          skills: { allowBundled: ["other"], entries: { disabled: { enabled: false } } },
          agents: {
            ownership: "explicit",
            defaults: { systemAgent: { agentId: "beta" } },
            entries: {
              alpha: { workspace: "/tmp/alpha" },
              beta: { workspace: workspaceDir, skills: [] },
            },
          },
        },
        gatewaySnapshot: {
          gatewayReachable: false,
          gatewayProbe: null,
          gatewayCallOverrides: undefined,
          gatewayConnection: {},
          remoteUrlMissing: false,
        },
        secretDiagnostics: [],
        tailscaleMode: "off",
        tailscaleDns: null,
        agentStatus: {
          agents: [
            {
              id: "alpha",
              workspaceDir: "/tmp/alpha",
              sessionsCount: 0,
              sessionsPath: "/tmp/alpha/sessions.json",
            },
            {
              id: "beta",
              workspaceDir,
              sessionsCount: 0,
              sessionsPath: path.join(workspaceDir, "sessions.json"),
            },
          ],
          defaultId: null,
          totalSessions: 0,
          bootstrapPendingCount: 0,
        },
        channels: { rows: [], details: [] },
        channelIssues: [],
        osSummary: { label: "test" },
      } as never,
      daemon: {} as never,
      nodeService: {} as never,
      nodeOnlyGateway: null,
      progress: { setLabel: vi.fn(), tick: vi.fn(), setPercent: vi.fn(), done: vi.fn() },
    };
    await withEnvAsync(
      { OPENCLAW_BUNDLED_SKILLS_DIR: bundledDir, PATH: binDir, PATHEXT: ".CMD" },
      async () => {
        const before = await buildStatusAllReportData(params);
        expect(before.diagnosis.skillReadiness).toEqual({ workspaceDir, eligible: 3, missing: 2 });
        expect(
          (await buildStatusAllReportLines({ ...before, progress: params.progress })).find((line) =>
            line.includes("Skills:"),
          ),
        ).toBe(`! Skills: 3 eligible · 2 missing · ${workspaceDir}`);
        await fs.writeFile(
          path.join(binDir, process.platform === "win32" ? `${missingBin}.CMD` : missingBin),
          "",
          { mode: 0o755 },
        );
        const after = await buildStatusAllReportData(params);
        expect(after.diagnosis.skillReadiness).toEqual({ workspaceDir, eligible: 4, missing: 1 });
        expect(
          (await buildStatusAllReportLines({ ...after, progress: params.progress })).find((line) =>
            line.includes("Skills:"),
          ),
        ).toBe(`! Skills: 4 eligible · 1 missing · ${workspaceDir}`);
        mocks.buildWorkspaceSkillReadiness.mockImplementationOnce(() => {
          throw new Error("Synthetic discovery failure");
        });
        const partial = await buildStatusAllReportData(params);
        expect(partial.diagnosis.skillReadiness).toBeNull();
        const partialLines = await buildStatusAllReportLines({
          ...partial,
          progress: params.progress,
        });
        expect(partialLines.some((line) => line.includes("Skills:"))).toBe(false);
        expect(partialLines.some((line) => line.includes("Diagnosis (read-only)"))).toBe(true);
      },
    );

    expect(mocks.resolveNodeExecEligibility).toHaveBeenCalledWith({
      cfg: expect.any(Object),
      execApprovals: { version: 1, agents: {} },
      agentId: "beta",
    });
    expect(mocks.buildWorkspaceSkillReadiness).toHaveBeenCalledWith(
      workspaceDir,
      expect.objectContaining({ agentId: "beta" }),
    );
  });

  it("does not inspect the first workspace when an explicit fleet has no owner", async () => {
    await buildStatusAllReportData({
      overview: {
        cfg: {
          agents: {
            ownership: "explicit",
            entries: {
              alpha: { workspace: "/tmp/alpha" },
              beta: { workspace: "/tmp/beta" },
            },
          },
        },
        gatewaySnapshot: {
          gatewayReachable: false,
          gatewayProbe: null,
          gatewayCallOverrides: undefined,
          gatewayConnection: {},
          remoteUrlMissing: false,
        },
        secretDiagnostics: [],
        tailscaleMode: "off",
        tailscaleDns: null,
        agentStatus: {
          agents: [
            { id: "alpha", workspaceDir: "/tmp/alpha" },
            { id: "beta", workspaceDir: "/tmp/beta" },
          ],
          defaultId: null,
        },
        channels: { rows: [], details: [] },
        channelIssues: [],
        osSummary: { label: "test" },
      } as never,
      daemon: {} as never,
      nodeService: {} as never,
      nodeOnlyGateway: {} as never,
      progress: { setLabel: vi.fn(), tick: vi.fn() },
    });

    expect(mocks.resolveNodeExecEligibility).not.toHaveBeenCalled();
    expect(mocks.buildWorkspaceSkillReadiness).not.toHaveBeenCalled();
  });
});
