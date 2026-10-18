// Status-all command tests cover local read-only probes and their rendered diagnostics.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../../../packages/terminal-core/src/ansi.js";
import * as terminalTable from "../../../packages/terminal-core/src/table.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { ProgressReporter } from "../../cli/progress.js";
import type { RestartSentinelPayload } from "../../infra/restart-sentinel.js";
import type { UpdateRunRecord } from "../../infra/update-run-record.js";
import { writeSkill } from "../../skills/test-support/e2e-test-helpers.js";
import { withEnvAsync } from "../../test-utils/env.js";
import type { resolveStatusServiceSummaries } from "../status-runtime-shared.ts";
import { createStatusGatewayProbeBudget } from "../status.gateway-probe-budget.js";
import type { resolveNodeOnlyGatewayInfo } from "../status.node-mode.js";
import type { collectStatusScanOverview } from "../status.scan-overview.ts";
import {
  baseStatusGatewaySnapshot,
  baseStatusOverviewSurface,
  createStatusScanResultFixture,
} from "../status.test-support.ts";

const mocks = vi.hoisted(() => ({
  collectStatusScanOverview: vi.fn(),
  resolveStatusServiceSummaries: vi.fn(),
  resolveNodeOnlyGatewayInfo: vi.fn(),
  progress: { setLabel: vi.fn(), tick: vi.fn(), setPercent: vi.fn(), done: vi.fn() },
  history: vi.fn<typeof import("../../infra/update-run-reader.js").getUpdateRunHistoryStatusAsync>(
    async () => ({}),
  ),
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

// mock-isolation: Database inspection is covered at its owner, not by unrelated local diagnostics.
vi.mock("../status-database-engines.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../status-database-engines.js")>()),
  resolveStatusDatabaseEngines: async () => ({ source: "admitted", stores: [] }),
}));

// mock-isolation: Supply scan/service facts without probing operator state or a live Gateway.
vi.mock("../../cli/progress.js", () => ({
  withProgress: async <T>(_options: unknown, run: (progress: ProgressReporter) => Promise<T>) =>
    run(mocks.progress),
}));
// mock-isolation: The command consumes the selected service projection without opening service state.
vi.mock("../status.node-mode.js", () => ({
  resolveNodeOnlyGatewayInfo: mocks.resolveNodeOnlyGatewayInfo,
}));
vi.mock("../../../packages/terminal-core/src/table.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../packages/terminal-core/src/table.js")>()),
  renderTable: vi.fn(({ rows }: { rows: Array<Record<string, string>> }) =>
    rows.map((row) => Object.values(row).join(": ")).join("\n"),
  ),
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
  getUpdateRun: mocks.getUpdateRun,
  getUpdateRunAsync: async (runId: string) => mocks.getUpdateRun(runId),
  reconcileAbandonedUpdateRunsAsync: async () => [],
}));
vi.mock("../../infra/update-run-reader.js", () => ({
  getUpdateRunHistoryStatusAsync: mocks.history,
}));
vi.mock("../../infra/restart-sentinel.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/restart-sentinel.js")>()),
  readRestartSentinelReadOnly: mocks.readRestartSentinelReadOnly,
}));
vi.mock("../../plugins/status.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/status.js")>()),
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
// mock-isolation: Keep live service, usage, and Gateway probes outside command rendering fixtures.
vi.mock("../status-runtime-shared.ts", () => ({
  resolveStatusServiceSummaries: mocks.resolveStatusServiceSummaries,
  resolveStatusGatewayDiagnosticsSafe: mocks.resolveStatusGatewayDiagnosticsSafe,
  resolveStatusGatewayHealthSafe: mocks.resolveStatusGatewayHealthSafe,
}));
vi.mock("../status.gateway-connection.ts", () => ({
  resolveStatusAllConnectionDetails: () => "",
}));
// mock-isolation: Reuse fixed scan facts while retaining the real downstream report rendering.
vi.mock("../status.scan-overview.ts", () => ({
  collectStatusScanOverview: mocks.collectStatusScanOverview,
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

import { statusAllCommand } from "../status-all.js";
import * as statusDiagnosis from "./diagnosis.js";

async function runStatusAllReport(params: {
  overview: Awaited<ReturnType<typeof collectStatusScanOverview>>;
  daemon: Awaited<ReturnType<typeof resolveStatusServiceSummaries>>[0];
  nodeService: Awaited<ReturnType<typeof resolveStatusServiceSummaries>>[1];
  nodeOnlyGateway: Awaited<ReturnType<typeof resolveNodeOnlyGatewayInfo>>;
  timeoutMs?: number;
  gatewayProbeDeadlineMs: number;
}) {
  mocks.collectStatusScanOverview.mockResolvedValueOnce(params.overview);
  mocks.resolveStatusServiceSummaries.mockResolvedValueOnce([params.daemon, params.nodeService]);
  mocks.resolveNodeOnlyGatewayInfo.mockResolvedValueOnce(params.nodeOnlyGateway);
  const log = vi.fn();
  await statusAllCommand(
    { log, error: vi.fn(), exit: vi.fn() },
    { timeoutMs: params.timeoutMs, gatewayProbeDeadlineMs: params.gatewayProbeDeadlineMs },
  );
  expect(log).toHaveBeenCalledOnce();
  return stripAnsi(String(log.mock.calls[0]?.[0])).split("\n");
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("statusAllCommand local diagnosis", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(terminalTable.renderTable).mockImplementation(({ rows }) =>
      rows.map((row) => Object.values(row).join(": ")).join("\n"),
    );
    mocks.buildWorkspaceSkillReadiness.mockReset().mockReturnValue({
      workspaceDir: "/tmp/mock-skills",
      eligible: 0,
      missing: 0,
    });
    vi.spyOn(performance, "now").mockReturnValue(0);
    mocks.history.mockResolvedValue({});
    mocks.getUpdateRun.mockReturnValue(undefined);
    mocks.readRestartSentinelReadOnly.mockResolvedValue(null);
    mocks.resolveStatusGatewayDiagnosticsSafe.mockResolvedValue({ ok: true, value: {} });
    mocks.resolveStatusGatewayHealthSafe.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
    "failed-healthy",
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
        if (history === "failed-healthy") {
          completed.status = "failed";
          completed.reason = "post-update-failed";
        }
        mocks.history.mockResolvedValue({ lastRun: completed });
        mocks.getUpdateRun.mockReturnValue(completed);
      }
      if (history === "active") {
        mocks.history.mockResolvedValue({
          lastRun: completed,
          activeRun: { ...completed, status: "running", phase: "verifying" },
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
      const report = await runStatusAllReport({
        ...createStatusGatewayProbeBudget(),
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
            gatewayProbe:
              history === "failed-healthy"
                ? { server: { version: "2026.9.2", buildId: "fixture-build" } }
                : null,
            gatewayCallOverrides: undefined,
            remoteUrlMissing: false,
            localGatewayHealthy: history === "failed-healthy",
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
      });

      expect(report.find((line) => line.startsWith("Update: "))).toContain("npm update 9999.1.1");
      expect(report.find((line) => line.startsWith("Update: "))).toContain("behind 2");
      const success = "✅ OpenClaw updated to 2026.9.2 (from 2026.9.1).";
      expect(report.filter((line) => /^(Update run|Update restart): /.test(line))).toEqual([
        ...(hasRun
          ? [
              `Update run: ${
                history === "active"
                  ? "⬆️ OpenClaw update in progress: verifying."
                  : history === "failed-healthy"
                    ? "Last update run failed (post-update-failed) — Gateway is serving 2026.9.2; run `openclaw update` to clear the record."
                    : success
              }`,
            ]
          : []),
        ...(hasSentinel && history !== "same-run" && history !== "generic-sentinel"
          ? [
              `Update restart: ${
                history === "mixed-sentinel"
                  ? "⚠️ OpenClaw update failed: restart-unhealthy."
                  : success
              }`,
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

  it.each([false, true])(
    "collects stability projections only after readiness (starting: %s)",
    async (starting) => {
      const report = await runStatusAllReport({
        ...createStatusGatewayProbeBudget(),
        overview: {
          cfg: {},
          gatewaySnapshot: {
            gatewayReachable: !starting,
            gatewayProbe: { error: null, ...(starting ? { startupPhase: "plugins" } : {}) },
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
      });

      if (starting) {
        expect(mocks.resolveStatusGatewayDiagnosticsSafe).not.toHaveBeenCalled();
        expect(mocks.resolveStatusGatewayHealthSafe).not.toHaveBeenCalled();
        expect(report.join("\n")).toContain("gateway still starting (phase plugins)");
        expect(report.join("\n")).not.toContain("Gateway health:");
        return;
      }

      expect(mocks.resolveStatusGatewayDiagnosticsSafe.mock.calls).toEqual([
        [
          expect.objectContaining({
            gatewayReachable: true,
            gatewayProbeDeadlineMs: 60_000,
          }),
        ],
        [
          expect.objectContaining({
            gatewayReachable: true,
            gatewayProbeDeadlineMs: 60_000,
            type: "telemetry.exporter",
          }),
        ],
      ]);
      expect(mocks.resolveStatusSummaryFromOverview).not.toHaveBeenCalled();
    },
  );

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
      ...createStatusGatewayProbeBudget(),
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
    };
    await withEnvAsync(
      { OPENCLAW_BUNDLED_SKILLS_DIR: bundledDir, PATH: binDir, PATHEXT: ".CMD" },
      async () => {
        const before = await runStatusAllReport(params);
        expect(before.find((line) => line.includes("Skills:"))).toBe(
          `! Skills: 3 eligible · 2 missing · ${workspaceDir}`,
        );
        await fs.writeFile(
          path.join(binDir, process.platform === "win32" ? `${missingBin}.CMD` : missingBin),
          "",
          { mode: 0o755 },
        );
        const after = await runStatusAllReport(params);
        expect(after.find((line) => line.includes("Skills:"))).toBe(
          `! Skills: 4 eligible · 1 missing · ${workspaceDir}`,
        );
        mocks.buildWorkspaceSkillReadiness.mockImplementationOnce(() => {
          throw new Error("Synthetic discovery failure");
        });
        const partialLines = await runStatusAllReport(params);
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
    await runStatusAllReport({
      ...createStatusGatewayProbeBudget(),
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
    });

    expect(mocks.resolveNodeExecEligibility).not.toHaveBeenCalled();
    expect(mocks.buildWorkspaceSkillReadiness).not.toHaveBeenCalled();
  });

  it("renders bootstrap state and invalid config diagnostics through status --all", async () => {
    const renderingEvents: string[] = [];
    const actual = await vi.importActual<
      typeof import("../../../packages/terminal-core/src/table.js")
    >("../../../packages/terminal-core/src/table.js");
    vi.mocked(terminalTable.renderTable).mockImplementation(actual.renderTable);
    const diagnosisSpy = vi
      .spyOn(statusDiagnosis, "appendStatusAllDiagnosis")
      .mockImplementation(async ({ lines }) => {
        renderingEvents.push("diagnosis");
        await Promise.resolve();
        lines.push("diagnosis body", "");
      });
    mocks.buildStatusAllOverviewRows.mockReturnValueOnce([
      {
        get Item() {
          renderingEvents.push("render Overview");
          return "Gateway";
        },
        Value: "ok",
      },
    ]);
    const scan = createStatusScanResultFixture();
    const service = {
      label: "gateway",
      installed: false,
      loadState: { status: "not-loaded" },
      managedByOpenClaw: false,
      externallyManaged: false,
      loadedText: "not loaded",
      runtime: undefined,
      loaded: false,
      runtimeShort: "not loaded",
    } satisfies Awaited<ReturnType<typeof resolveStatusServiceSummaries>>[0];
    const lines = await runStatusAllReport({
      ...createStatusGatewayProbeBudget(),
      daemon: service,
      nodeService: service,
      nodeOnlyGateway: null,
      overview: {
        ...scan,
        coldStart: false,
        hasConfiguredChannels: true,
        skipColdStartNetworkChecks: false,
        gatewaySnapshot: baseStatusGatewaySnapshot,
        runtimeDegradation: null,
        channelsStatus: null,
        configDiagnostics: {
          path: "/tmp/openclaw.json",
          issues: [{ path: "gateway.port", message: "invalid" }],
        },
        channels: {
          rows: [
            {
              id: "discord",
              label: "Discord",
              enabled: true,
              state: "ok",
              detail: "connected",
            },
          ],
          details: [
            {
              title: "Discord accounts",
              columns: ["Account", "Status", "Notes"],
              rows: [
                {
                  Account: "default",
                  get Status() {
                    renderingEvents.push("prepare detail");
                    return "OK";
                  },
                  Notes: "ready",
                },
              ],
            },
            { title: "Empty accounts", columns: ["Account", "Status"], rows: [] },
          ],
        },
        channelIssues: [
          {
            channel: "discord",
            accountId: "default",
            kind: "runtime",
            message: `${"x".repeat(89)}🚀tail`,
          },
        ],
        agentStatus: {
          ...scan.agentStatus,
          agents: [
            {
              id: "main",
              workspaceDir: null,
              lastUpdatedAt: null,
              get bootstrapPending() {
                renderingEvents.push("prepare agent");
                return true;
              },
              sessionsCount: 1,
              lastActiveAgeMs: 12_000,
              sessionsPath: "/tmp/main-sessions.json",
            },
            {
              id: "ops",
              workspaceDir: null,
              lastUpdatedAt: null,
              bootstrapPending: false,
              sessionsCount: 0,
              lastActiveAgeMs: null,
              sessionsPath: "/tmp/ops-sessions.json",
            },
          ],
        },
      },
    });

    expect(renderingEvents.filter((event, index) => event !== renderingEvents[index - 1])).toEqual([
      "prepare detail",
      "prepare agent",
      "render Overview",
      "diagnosis",
    ]);
    const output = lines.join("\n");
    expect(output).toContain("Bootstrap file");
    expect(output).toContain("PRESENT");
    expect(output).toContain("ABSENT");
    expect(output).toContain("Config diagnostics:");
    expect(output).toContain("Config file is invalid: /tmp/openclaw.json");
    expect(output).toContain("gateway.port: invalid");
    expect(output).toContain("Fix: openclaw doctor --fix");
    expect(output.indexOf("Config diagnostics:")).toBeLessThan(
      output.indexOf("OpenClaw status --all"),
    );
    expect(output).not.toContain(String.fromCharCode(0xd83d));
    expect(
      lines.filter((line) =>
        /^(Overview|Channels|Discord accounts|Empty accounts|Agents|Diagnosis \(read-only\))$/.test(
          line,
        ),
      ),
    ).toEqual([
      "Overview",
      "Channels",
      "Discord accounts",
      "Empty accounts",
      "Agents",
      "Diagnosis (read-only)",
    ]);
    expect(lines.slice(-4)).toEqual(["", "Diagnosis (read-only)", "diagnosis body", ""]);
    expect(diagnosisSpy).toHaveBeenCalledOnce();
    expect(diagnosisSpy).toHaveBeenCalledWith(expect.objectContaining({ secretDiagnostics: [] }));
  });
});
