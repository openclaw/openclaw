import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { getTerminalTableWidth } from "../../packages/terminal-core/src/table.js";
import { isRich, theme } from "../../packages/terminal-core/src/theme.js";
import { resolveNodeExecEligibility } from "../agents/exec-defaults.js";
import { withProgress, type ProgressReporter } from "../cli/progress.js";
import { readConfigFileSnapshot, resolveGatewayPort } from "../config/config.js";
import { readLastGatewayErrorLine } from "../daemon/diagnostics.js";
import { resolveGatewayBindHost, resolveGatewayRequiredListenHosts } from "../gateway/net.js";
import { loadExecApprovalsReadOnly } from "../infra/exec-approvals.js";
import { inspectPortUsage } from "../infra/ports-inspect.js";
import { formatUsageReportLines } from "../infra/provider-usage.format.js";
import { readRestartSentinelReadOnly } from "../infra/restart-sentinel.js";
import { resolvePluginControlPlaneWorkspace } from "../plugins/control-plane-workspace.js";
import { buildPluginCompatibilityNotices, withPluginDiagnosticsReport } from "../plugins/status.js";
import type { RuntimeEnv } from "../runtime.js";
import { buildWorkspaceSkillReadiness } from "../skills/discovery/status.js";
import { getRemoteSkillEligibility } from "../skills/runtime/remote.js";
import {
  buildStatusChannelsTableRows,
  statusChannelsTableColumns,
} from "./status-all/channels-table.js";
import { appendStatusAllDiagnosis, readStatusAllLogTails } from "./status-all/diagnosis.js";
import {
  buildStatusAgentTableRows,
  buildStatusChannelDetailSections,
  statusAgentsTableColumns,
  statusOverviewTableColumns,
} from "./status-all/report-tables.js";
import { appendStatusReportHeading, appendStatusReportTable } from "./status-all/text-report.js";
import { resolveStatusDatabaseEngines } from "./status-database-engines.js";
import { buildStatusAllOverviewRows } from "./status-overview-rows.ts";
import {
  reportStatusScanFailure,
  resolveStatusServiceSummaries,
  resolveStatusUsageSummary,
  resolveStatusGatewayDiagnosticsSafe,
  resolveStatusGatewayHealthSafe,
} from "./status-runtime-shared.ts";
import { buildStatusUpdateRows } from "./status-update-restart.ts";
import { formatStatusConfigDiagnosticEntries } from "./status.format.js";
import { resolveStatusAllConnectionDetails } from "./status.gateway-connection.ts";
import {
  resolveStatusGatewayProbeTimeoutMs,
  type StatusGatewayProbeBudget,
} from "./status.gateway-probe-budget.js";
import { resolveNodeOnlyGatewayInfo, type NodeOnlyGatewayInfo } from "./status.node-mode.js";
import {
  collectStatusScanOverview,
  prepareStatusSummaryFromOverview,
  type StatusScanOverviewResult,
} from "./status.scan-overview.ts";

async function resolveStatusAllLocalDiagnosis(params: {
  overview: StatusScanOverviewResult;
  progress: Pick<ProgressReporter, "setLabel" | "tick">;
  nodeOnlyGateway: NodeOnlyGatewayInfo | null;
  timeoutMs?: number;
  gatewayProbeDeadlineMs: number;
}) {
  const { overview } = params;
  const { gatewayReachable, gatewayProbe, gatewayCallOverrides } = overview.gatewaySnapshot;
  const snap = await readConfigFileSnapshot({ observe: false }).catch(() => null);
  const configPath = snap?.path?.trim() || "(unknown config path)";
  const diagnosticsParams = {
    config: overview.cfg,
    gatewayProbeDeadlineMs: params.gatewayProbeDeadlineMs,
    timeoutMs: Math.min(5000, params.timeoutMs ?? 10_000),
    gatewayReachable,
    ...(gatewayCallOverrides ? { callOverrides: gatewayCallOverrides } : {}),
  };

  const [health, deliveryDiagnostics, exporterDiagnostics] =
    params.nodeOnlyGateway || gatewayProbe?.startupPhase
      ? [undefined, null, null]
      : await Promise.all([
          resolveStatusGatewayHealthSafe({
            ...diagnosticsParams,
            timeoutMs: Math.min(8000, params.timeoutMs ?? 10_000),
            gatewayProbeError: gatewayProbe?.error ?? null,
          }),
          resolveStatusGatewayDiagnosticsSafe(diagnosticsParams),
          resolveStatusGatewayDiagnosticsSafe({
            ...diagnosticsParams,
            type: "telemetry.exporter",
          }),
        ]);

  params.progress.setLabel("Checking local state…");
  // These probes are intentionally best-effort so status-all can still print a partial report.
  const sentinel = await readRestartSentinelReadOnly().catch(() => null);
  const lastErr = await readLastGatewayErrorLine(process.env).catch(() => null);
  const port = resolveGatewayPort(overview.cfg);
  const bindHost = await resolveGatewayBindHost(
    overview.cfg.gateway?.bind ?? "loopback",
    overview.cfg.gateway?.customBindHost,
  );
  const portUsage = await inspectPortUsage(port, {
    probeHosts: resolveGatewayRequiredListenHosts(bindHost),
  }).catch(() => null);
  params.progress.tick();

  const controlPlaneWorkspace = resolvePluginControlPlaneWorkspace({
    config: overview.cfg,
    env: process.env,
  });
  const defaultWorkspace = controlPlaneWorkspace.workspaceDir ?? null;
  let skillReadiness: ReturnType<typeof buildWorkspaceSkillReadiness> | null = null;
  if (defaultWorkspace != null) {
    try {
      // Skill eligibility depends on whether the default agent may request node exec.
      const nodeSkills = resolveNodeExecEligibility({
        cfg: overview.cfg,
        execApprovals: loadExecApprovalsReadOnly(),
        agentId: controlPlaneWorkspace.agentId,
      });
      skillReadiness = buildWorkspaceSkillReadiness(defaultWorkspace, {
        config: overview.cfg,
        agentId: controlPlaneWorkspace.agentId,
        eligibility: {
          nodeSkills,
          remote: getRemoteSkillEligibility({
            advertiseExecNode: nodeSkills.canExec,
          }),
        },
      });
    } catch {
      // Preserve a partial report when local skill inspection fails.
    }
  }
  const pluginCompatibility = await withPluginDiagnosticsReport(
    { config: overview.cfg },
    (report) => buildPluginCompatibilityNotices({ report }),
  );

  return {
    configPath,
    diagnosis: {
      snap,
      remoteUrlMissing: overview.gatewaySnapshot.remoteUrlMissing,
      secretDiagnostics: overview.secretDiagnostics,
      sentinel,
      lastErr,
      port,
      portUsage,
      tailscaleMode: overview.tailscaleMode,
      tailscaleDns: overview.tailscaleDns,
      tailscaleHttpsUrl: overview.tailscaleHttpsUrl,
      skillReadiness,
      pluginCompatibility,
      channelsStatus: overview.channelsStatus,
      channelIssues: overview.channelIssues,
      gatewayReachable,
      gatewayStartupPhase: gatewayProbe?.startupPhase,
      localGatewayHealthy:
        overview.gatewaySnapshot.localGatewayHealthy === true && !(health && "error" in health),
      gatewayServer: gatewayProbe?.server,
      health,
      deliveryDiagnostics,
      exporterDiagnostics,
      nodeOnlyGateway: params.nodeOnlyGateway,
    },
  };
}

// Orchestrates the scan, local service probes, and report rendering while report builders own formatting.

/** Runs the full read-only status report and writes it to the runtime logger. */
export async function statusAllCommand(
  runtime: RuntimeEnv,
  opts: StatusGatewayProbeBudget & { usage?: boolean; agent?: string },
): Promise<void> {
  await withProgress({ label: "Scanning status --all…", total: 11 }, async (progress) => {
    const overview = await collectStatusScanOverview({
      env: process.env,
      commandName: "status --all",
      opts: {
        timeoutMs: opts.timeoutMs,
        gatewayProbeDeadlineMs: opts.gatewayProbeDeadlineMs,
      },
      showSecrets: false,
      runtime,
      // status --all can afford gateway overrides so channel summaries reflect live runtime state.
      useGatewayCallOverridesForChannelsStatus: true,
      includeAdvertisedControlUiLinks: true,
      progress,
      labels: {
        loadingConfig: "Loading config…",
        checkingTailscale: "Checking Tailscale…",
        checkingForUpdates: "Checking for updates…",
        resolvingAgents: "Scanning agents…",
        probingGateway: "Checking gateway…",
        queryingChannelStatus: "Querying gateway…",
        summarizingChannels: "Summarizing channels…",
      },
    }).catch((error: unknown) => reportStatusScanFailure(error, runtime, opts?.timeoutMs));
    progress.setLabel("Checking services…");
    const [daemon, nodeService] = await resolveStatusServiceSummaries(opts.timeoutMs);
    const nodeOnlyGateway = await resolveNodeOnlyGatewayInfo({
      daemon,
      node: nodeService,
    });
    progress.tick();
    const gatewaySnapshot = overview.gatewaySnapshot;
    const runtimeDegradation = overview.runtimeDegradation;
    const [{ configPath, diagnosis }, prepared] = await Promise.all([
      resolveStatusAllLocalDiagnosis({
        overview,
        progress,
        nodeOnlyGateway,
        timeoutMs: opts.timeoutMs,
        gatewayProbeDeadlineMs: opts.gatewayProbeDeadlineMs,
      }),
      runtimeDegradation
        ? { publish: () => ({ summary: runtimeDegradation, sessionStores: undefined }) }
        : prepareStatusSummaryFromOverview({ overview }),
    ]);

    const databaseEngines = await resolveStatusDatabaseEngines(
      overview.cfg,
      runtimeDegradation?.databaseStores,
    );
    const updateRows = await buildStatusUpdateRows(diagnosis.sentinel?.payload, {
      localGatewayHealthy: diagnosis.localGatewayHealthy,
      gatewayServer: diagnosis.gatewayServer,
    });
    const usage = opts.usage
      ? await resolveStatusUsageSummary({
          config: overview.cfg,
          timeoutMs: resolveStatusGatewayProbeTimeoutMs(opts),
          gatewayProbeDeadlineMs: opts.gatewayProbeDeadlineMs,
          ...(opts.agent ? { agentId: opts.agent } : {}),
        })
      : undefined;
    progress.setLabel("Reading logs…");
    const logTails = await readStatusAllLogTails();
    const { summary, sessionStores } = prepared.publish();
    const agentStatus =
      "publish" in overview.agentStatus
        ? overview.agentStatus.publish(sessionStores)
        : overview.agentStatus;
    const overviewSurface = {
      ...overview,
      agentStatus,
      ...gatewaySnapshot,
      gatewayService: daemon,
      nodeService,
      nodeOnlyGateway,
      databaseEngines,
    };
    const overviewRows = buildStatusAllOverviewRows({
      surface: overviewSurface,
      osLabel: overview.osSummary.label,
      configPath,
      summary,
      secretDiagnosticsCount: overview.secretDiagnostics.length,
      updateRows,
      agentStatus,
    });
    const connectionDetailsForReport = resolveStatusAllConnectionDetails({
      nodeOnlyGateway,
      remoteUrlMissing: gatewaySnapshot.remoteUrlMissing,
      gatewayConnection: gatewaySnapshot.gatewayConnection,
      bindMode: overview.cfg.gateway?.bind ?? "loopback",
      configPath,
    });
    const rich = isRich();
    const heading = (text: string) => (rich ? theme.heading(text) : text);
    const ok = (text: string) => (rich ? theme.success(text) : text);
    const warn = (text: string) => (rich ? theme.warn(text) : text);
    const fail = (text: string) => (rich ? theme.error(text) : text);
    const muted = (text: string) => (rich ? theme.muted(text) : text);

    const tableWidth = getTerminalTableWidth();

    const lines: string[] = [];
    if (overview.configDiagnostics) {
      lines.push(
        warn("Config diagnostics:"),
        ...formatStatusConfigDiagnosticEntries(overview.configDiagnostics),
        "",
      );
    }
    lines.push(heading("OpenClaw status --all"));
    const report = { lines, heading, width: tableWidth };
    const overviewColumns = [...statusOverviewTableColumns];
    // Prepare every styled row before table rendering so callbacks retain their existing order.
    const channelColumns = statusChannelsTableColumns.map((column) =>
      column.key === "Detail" ? Object.assign({}, column, { minWidth: 28 }) : column,
    );
    const channelRows = buildStatusChannelsTableRows({
      rows: overview.channels.rows,
      channelIssues: overview.channelIssues,
      ok,
      warn,
      muted,
      accentDim: theme.accentDim,
      formatIssueMessage: (message) => truncateUtf16Safe(message, 90),
    });
    const details = buildStatusChannelDetailSections({
      details: overview.channels.details,
      ok,
      warn,
    });
    const agentColumns = [...statusAgentsTableColumns];
    const agentRows = buildStatusAgentTableRows({ agentStatus, ok, warn });

    appendStatusReportTable(report, "Overview", overviewColumns, overviewRows);
    appendStatusReportTable(report, "Channels", channelColumns, channelRows);
    for (const detail of details) {
      appendStatusReportTable(report, detail.title, detail.columns, detail.rows);
    }
    appendStatusReportTable(report, "Agents", agentColumns, agentRows);
    appendStatusReportHeading(report, "Diagnosis (read-only)");

    appendStatusAllDiagnosis({
      logTails,
      agentStatus,
      lines,
      progress,
      muted,
      ok,
      warn,
      fail,
      connectionDetailsForReport,
      ...diagnosis,
    });

    if (usage) {
      lines.push("", ...formatUsageReportLines(usage));
    }

    progress.setLabel("Rendering…");
    runtime.log(lines.join("\n"));
    progress.tick();
  });
}
