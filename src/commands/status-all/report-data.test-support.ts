import { afterEach, beforeEach, expect, vi } from "vitest";
import { stripAnsi } from "../../../packages/terminal-core/src/ansi.js";
import type { ProgressReporter } from "../../cli/progress.js";
import type { PortUsage } from "../../infra/ports.js";
import type { RestartSentinelPayload } from "../../infra/restart-sentinel.js";
import type { UpdateRunRecord } from "../../infra/update-run-record.js";
import type { resolveStatusServiceSummaries } from "../status-runtime-shared.ts";
import { createStatusGatewayProbeBudget } from "../status.gateway-probe-budget.js";
import type { resolveNodeOnlyGatewayInfo } from "../status.node-mode.js";
import type { collectStatusScanOverview } from "../status.scan-overview.ts";
import {
  baseStatusGatewaySnapshot,
  createStatusHealth,
  createStatusScanResultFixture,
} from "../status.test-support.ts";
import { createTestConfigSnapshot } from "../test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => {
  const noLogs = () => {
    throw new Error("No fixture logs");
  };
  return {
    renderTable: vi.fn<typeof import("../../../packages/terminal-core/src/table.js").renderTable>(
      ({ rows }) => rows.map((row) => Object.values(row).join(": ")).join("\n"),
    ),
    collectStatusScanOverview: vi.fn(),
    resolveStatusServiceSummaries: vi.fn(),
    resolveNodeOnlyGatewayInfo: vi.fn(),
    progress: { setLabel: vi.fn(), tick: vi.fn(), setPercent: vi.fn(), done: vi.fn() },
    history: vi.fn<
      typeof import("../../infra/update-run-reader.js").getUpdateRunHistoryStatusAsync
    >(async () => ({})),
    getUpdateRun: vi.fn<(runId: string) => UpdateRunRecord | undefined>(),
    readRestartSentinelReadOnly: vi.fn<() => Promise<{ payload: RestartSentinelPayload } | null>>(
      async () => null,
    ),
    buildStatusAllOverviewRows: vi.fn<
      typeof import("../status-overview-rows.ts").buildStatusAllOverviewRows
    >(() => []),
    readConfigFileSnapshot: vi.fn<typeof import("../../config/config.js").readConfigFileSnapshot>(
      async () => createTestConfigSnapshot({}),
    ),
    inspectPortUsage: vi.fn<() => Promise<PortUsage | null>>(async () => null),
    resolveStatusGatewayDiagnosticsSafe: vi.fn<
      typeof import("../status-runtime-shared.ts").resolveStatusGatewayDiagnosticsSafe
    >(async () => ({ ok: true, value: {} })),
    resolveStatusGatewayHealthSafe: vi.fn<
      typeof import("../status-runtime-shared.ts").resolveStatusGatewayHealthSafe
    >(async () => createStatusHealth()),
    resolveNodeExecEligibility: vi.fn(() => ({ canExec: false })),
    buildWorkspaceSkillReadiness: vi.fn<
      typeof import("../../skills/discovery/status.js").buildWorkspaceSkillReadiness
    >(() => ({ workspaceDir: "/tmp/mock-skills", eligible: 0, missing: 0 })),
    resolveStatusAllConnectionDetails: vi.fn(() => ""),
    resolveGatewayLogPaths:
      vi.fn<typeof import("../../daemon/restart-logs.js").resolveGatewayLogPaths>(noLogs),
    resolveGatewaySupervisorLogPaths:
      vi.fn<typeof import("../../daemon/restart-logs.js").resolveGatewaySupervisorLogPaths>(noLogs),
    resolveGatewayRestartLogPath: vi.fn(() => "/tmp/fixture-restart.log"),
    readFileTailLines: vi.fn<typeof import("./gateway.js").readFileTailLines>(async () => []),
  };
});

export { mocks };

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
  renderTable: mocks.renderTable,
}));

vi.mock("../../agents/exec-defaults.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/exec-defaults.js")>()),
  resolveNodeExecEligibility: mocks.resolveNodeExecEligibility,
}));
vi.mock("../../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/config.js")>()),
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
  resolveGatewayPort: () => 18789,
}));
vi.mock("../../daemon/diagnostics.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/diagnostics.js")>()),
  readLastGatewayErrorLine: async () => null,
}));
vi.mock("../../gateway/net.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../gateway/net.js")>()),
  resolveGatewayBindHost: async () => "127.0.0.1",
}));
vi.mock("../../infra/ports-inspect.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/ports-inspect.js")>()),
  inspectPortUsage: mocks.inspectPortUsage,
}));
vi.mock("../../infra/exec-approvals.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/exec-approvals.js")>()),
  loadExecApprovalsReadOnly: () => ({ version: 1, agents: {} }),
}));
vi.mock("../../infra/update-run-ledger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-run-ledger.js")>()),
  getUpdateRun: mocks.getUpdateRun,
  getUpdateRunAsync: async (runId: string) => mocks.getUpdateRun(runId),
  reconcileAbandonedUpdateRunsAsync: async () => [],
}));
vi.mock("../../infra/update-run-reader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-run-reader.js")>()),
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
vi.mock("../../skills/discovery/status.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../skills/discovery/status.js")>()),
  buildWorkspaceSkillReadiness: mocks.buildWorkspaceSkillReadiness,
}));
vi.mock("../../skills/runtime/remote.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../skills/runtime/remote.js")>()),
  getRemoteSkillEligibility: () => ({}),
}));
vi.mock("../status-overview-rows.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../status-overview-rows.ts")>()),
  buildStatusAllOverviewRows: mocks.buildStatusAllOverviewRows,
}));
// mock-isolation: Keep live service, usage, and Gateway probes outside command rendering fixtures.
vi.mock("../status-runtime-shared.ts", () => ({
  resolveStatusServiceSummaries: mocks.resolveStatusServiceSummaries,
  resolveStatusGatewayDiagnosticsSafe: mocks.resolveStatusGatewayDiagnosticsSafe,
  resolveStatusGatewayHealthSafe: mocks.resolveStatusGatewayHealthSafe,
}));
vi.mock("../status.gateway-connection.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../status.gateway-connection.ts")>()),
  resolveStatusAllConnectionDetails: mocks.resolveStatusAllConnectionDetails,
}));
// mock-isolation: Reuse fixed scan facts while retaining the real downstream report rendering.
vi.mock("../status.scan-overview.ts", () => ({
  collectStatusScanOverview: mocks.collectStatusScanOverview,
  prepareStatusSummaryFromOverview: async () => ({
    publish: () => ({ summary: {}, sessionStores: undefined }),
  }),
}));

vi.mock("../../daemon/restart-logs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/restart-logs.js")>()),
  resolveGatewayLogPaths: mocks.resolveGatewayLogPaths,
  resolveGatewaySupervisorLogPaths: mocks.resolveGatewaySupervisorLogPaths,
  resolveGatewayRestartLogPath: mocks.resolveGatewayRestartLogPath,
}));
// mock-isolation: Supply bounded log-file reads while preserving summarization and redaction.
vi.mock("./gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gateway.js")>()),
  readFileTailLines: mocks.readFileTailLines,
}));

import { statusAllCommand } from "../status-all.js";

export async function runStatusAllReport(
  params: Partial<{
    overview: Partial<Awaited<ReturnType<typeof collectStatusScanOverview>>>;
    nodeOnlyGateway: Awaited<ReturnType<typeof resolveNodeOnlyGatewayInfo>>;
  }> = {},
) {
  const service = {
    label: "gateway",
    installed: false,
    loadState: { status: "not-loaded" },
    managedByOpenClaw: false,
    externallyManaged: false,
    loadedText: "not loaded",
    loaded: false,
    runtime: undefined,
    runtimeShort: "not loaded",
  } satisfies Awaited<ReturnType<typeof resolveStatusServiceSummaries>>[0];
  mocks.collectStatusScanOverview.mockResolvedValueOnce({
    ...createStatusScanResultFixture(),
    skipColdStartNetworkChecks: false,
    gatewaySnapshot: baseStatusGatewaySnapshot,
    runtimeDegradation: null,
    channelsStatus: null,
    ...params.overview,
  });
  mocks.resolveStatusServiceSummaries.mockResolvedValueOnce([service, service]);
  mocks.resolveNodeOnlyGatewayInfo.mockResolvedValueOnce(params.nodeOnlyGateway ?? null);
  const log = vi.fn();
  await statusAllCommand({ log, error: vi.fn(), exit: vi.fn() }, createStatusGatewayProbeBudget());
  expect(log).toHaveBeenCalledOnce();
  return stripAnsi(String(log.mock.calls[0]?.[0])).split("\n");
}

export async function reportText(params: Parameters<typeof runStatusAllReport>[0] = {}) {
  return (await runStatusAllReport(params)).join("\n");
}

export function expectReport(
  output: string,
  contains: readonly string[],
  excludes: readonly string[] = [],
) {
  for (const text of contains) {
    expect(output).toContain(text);
  }
  for (const text of excludes) {
    expect(output).not.toContain(text);
  }
}

export function setupStatusAllReportTest() {
  beforeEach(() => {
    const { progress, ...functions } = mocks;
    for (const mock of [...Object.values(functions), ...Object.values(progress)]) {
      mock.mockReset();
    }
    vi.spyOn(performance, "now").mockReturnValue(0);
  });

  afterEach(() => vi.restoreAllMocks());
}
