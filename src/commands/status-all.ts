import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { getTerminalTableWidth } from "../../packages/terminal-core/src/table.js";
import { isRich, theme } from "../../packages/terminal-core/src/theme.js";
import { resolveNodeExecEligibility } from "../agents/exec-defaults.js";
import { withProgress, type ProgressReporter } from "../cli/progress.js";
import { readConfigFileSnapshot, resolveGatewayPort } from "../config/config.js";
import { formatConfigIssueLine } from "../config/issue-format.js";
import { readLastGatewayErrorLine } from "../daemon/diagnostics.js";
import {
  resolveGatewayLogPaths,
  resolveGatewayRestartLogPath,
  resolveGatewaySupervisorLogPaths,
} from "../daemon/restart-logs.js";
import { resolveGatewayBindHost, resolveGatewayRequiredListenHosts } from "../gateway/net.js";
import { loadExecApprovalsReadOnly } from "../infra/exec-approvals.js";
import { inspectPortUsage } from "../infra/ports-inspect.js";
import {
  classifyPortListener,
  formatPortDiagnostics,
  isDualStackLoopbackGatewayListeners,
  isExpectedGatewayListeners,
  type PortUsage,
} from "../infra/ports.js";
import { formatUsageReportLines } from "../infra/provider-usage.format.js";
import {
  readRestartSentinelReadOnly,
  summarizeRestartSentinel,
} from "../infra/restart-sentinel.js";
import { resolvePluginControlPlaneWorkspace } from "../plugins/control-plane-workspace.js";
import {
  buildPluginCompatibilityNotices,
  formatPluginCompatibilityNotice,
  withPluginDiagnosticsReport,
} from "../plugins/status.js";
import type { RuntimeEnv } from "../runtime.js";
import { dedupeByKey } from "../shared/dedupe-by-key.js";
import { buildWorkspaceSkillReadiness } from "../skills/discovery/status.js";
import { getRemoteSkillEligibility } from "../skills/runtime/remote.js";
import { formatDeliveryQueueHealthLine } from "./health-format.js";
import {
  buildStatusChannelsTableRows,
  statusChannelsTableColumns,
} from "./status-all/channels-table.js";
import { formatTimeAgo, redactStatusSecrets } from "./status-all/format.js";
import { readFileTailLines, summarizeLogTail } from "./status-all/gateway.js";
import {
  buildStatusAgentTableRows,
  buildStatusChannelDetailSections,
  statusAgentsTableColumns,
  statusOverviewTableColumns,
} from "./status-all/report-tables.js";
import { appendStatusReportHeading, appendStatusReportTable } from "./status-all/text-report.js";
import { resolveStatusDatabaseEngines } from "./status-database-engines.js";
import { buildStatusAllOverviewRows } from "./status-overview-rows.ts";
import { countActiveStatusAgents } from "./status-overview-values.js";
import {
  reportStatusScanFailure,
  resolveStatusServiceSummaries,
  resolveStatusUsageSummary,
  resolveStatusGatewayDiagnosticsSafe,
  resolveStatusGatewayHealthSafe,
} from "./status-runtime-shared.ts";
import {
  buildStatusUpdateRows,
  formatUpdateRestartActionLines,
  formatUpdateRestartStatusValue,
} from "./status-update-restart.ts";
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
import { formatTelemetryExporterSummary } from "./telemetry-exporter-summary.js";

type DeliveryDiagnosticsLike = {
  summary?: {
    byType?: Record<string, number>;
  };
  events?: Array<{
    type?: string;
    ts?: number;
    channel?: string;
    outcome?: string;
    reason?: string;
  }>;
};

const AGENT_ACTIVITY_SOFT_WARNING_MS = 30 * 60_000;

function countGatewayListenerPids(portUsage: PortUsage): number {
  const pids = new Set<number>();
  for (const listener of portUsage.listeners) {
    if (classifyPortListener(listener) !== "gateway") {
      continue;
    }
    if (typeof listener.pid === "number" && Number.isFinite(listener.pid)) {
      pids.add(listener.pid);
    }
  }
  return pids.size;
}

function isDeliveryDiagnosticsLike(value: unknown): value is DeliveryDiagnosticsLike {
  return Boolean(value && typeof value === "object");
}

function countDeliveryEvent(snapshot: DeliveryDiagnosticsLike, type: string): number {
  const value = snapshot.summary?.byType?.[type];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function latestDeliveryEventAgeMs(snapshot: DeliveryDiagnosticsLike): number | null {
  // Only inbound/dispatch lifecycle events count as delivery freshness signals.
  const latestTs = (snapshot.events ?? [])
    .filter((event) =>
      [
        "message.received",
        "message.dispatch.started",
        "message.dispatch.completed",
        "session.turn.created",
        "message.processed",
      ].includes(event.type ?? ""),
    )
    .reduce((max, event) => {
      const ts = event.ts;
      return typeof ts === "number" && Number.isFinite(ts) ? Math.max(max, ts) : max;
    }, 0);
  return latestTs > 0 ? Date.now() - latestTs : null;
}

async function readStatusAllLogTails() {
  const logPaths = (() => {
    try {
      // macOS supervised installs write stdout/stderr differently than node-managed gateway logs.
      return process.platform === "darwin"
        ? resolveGatewaySupervisorLogPaths(process.env)
        : resolveGatewayLogPaths(process.env);
    } catch {
      return null;
    }
  })();
  if (logPaths) {
    const restartLogPath = resolveGatewayRestartLogPath(process.env);
    const readStderr = process.platform !== "darwin";
    const [stderrTail, stdoutTail, restartTail] = await Promise.all([
      readStderr ? readFileTailLines(logPaths.stderrPath, 40) : [],
      readFileTailLines(logPaths.stdoutPath, 40),
      readFileTailLines(restartLogPath, 30),
    ]);
    return { logPaths, restartLogPath, readStderr, stderrTail, stdoutTail, restartTail };
  }
  return null;
}

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

    const emitDetail = (text: string) => lines.push(`  ${muted(text)}`);
    const emitLimited = <T>(items: T[], limit: number, format: (item: T) => string) => {
      for (const item of items.slice(0, limit)) {
        lines.push(format(item));
      }
      if (items.length > limit) {
        emitDetail(`… +${items.length - limit} more`);
      }
    };

    const emitCheck = (label: string, status: "ok" | "warn" | "fail") => {
      const decorate = status === "ok" ? ok : status === "warn" ? warn : fail;
      const icon = status === "ok" ? "✓" : status === "warn" ? "!" : "✗";
      lines.push(`${decorate(icon)} ${decorate(label)}`);
    };
    const emitUnavailableDiagnostics = (diagnostic: {
      label: string;
      detail: string;
      retry: string;
    }) => {
      emitCheck(`${diagnostic.label}: unavailable`, "warn");
      emitDetail(
        sanitizeTerminalText(redactStatusSecrets(redactSensitiveUrlLikeString(diagnostic.detail))),
      );
      emitDetail(`Retry: ${diagnostic.retry}`);
    };

    lines.push("");
    lines.push(muted("Gateway connection details:"));
    for (const line of redactStatusSecrets(connectionDetailsForReport)
      .split("\n")
      .map((l) => l.trimEnd())) {
      emitDetail(line);
    }

    lines.push("");
    if (diagnosis.snap) {
      const status = !diagnosis.snap.exists ? "fail" : diagnosis.snap.valid ? "ok" : "warn";
      emitCheck(`Config: ${diagnosis.snap.path ?? "(unknown)"}`, status);
      // Length-prefix the path to keep arbitrary path/message pairs distinct.
      const uniqueIssues = dedupeByKey(
        [...(diagnosis.snap.legacyIssues ?? []), ...(diagnosis.snap.issues ?? [])],
        (issue) => `${issue.path.length}:${issue.path}${issue.message}`,
      );
      emitLimited(uniqueIssues, 12, (issue) => `  ${formatConfigIssueLine(issue, "-")}`);
    } else {
      emitCheck("Config: read failed", "warn");
    }

    if (diagnosis.remoteUrlMissing) {
      lines.push("");
      emitCheck("Gateway remote mode misconfigured (gateway.remote.url missing)", "warn");
      emitDetail("Fix: set gateway.remote.url, or set gateway.mode=local.");
    }

    emitCheck(
      `Secret diagnostics (${diagnosis.secretDiagnostics.length})`,
      diagnosis.secretDiagnostics.length === 0 ? "ok" : "warn",
    );
    emitLimited(
      diagnosis.secretDiagnostics,
      10,
      (diagnostic) => `  - ${muted(redactStatusSecrets(diagnostic))}`,
    );

    if (diagnosis.sentinel?.payload) {
      emitCheck("Restart sentinel present", "warn");
      emitDetail(
        `${summarizeRestartSentinel(diagnosis.sentinel.payload)} · ${formatTimeAgo(Date.now() - diagnosis.sentinel.payload.ts)}`,
      );
      const updateRestartValue = formatUpdateRestartStatusValue(diagnosis.sentinel.payload, {
        localGatewayHealthy: diagnosis.localGatewayHealthy,
        gatewayServer: diagnosis.gatewayServer,
      });
      if (updateRestartValue) {
        emitDetail(`Update restart: ${updateRestartValue}`);
      }
      for (const line of formatUpdateRestartActionLines(diagnosis.sentinel.payload)) {
        emitDetail(line);
      }
    } else {
      emitCheck("Restart sentinel: none", "ok");
    }

    const lastErrClean = normalizeOptionalString(diagnosis.lastErr) ?? "";
    // Restart logs sometimes end with a single brace from truncated JSON; suppress that noise.
    const isTrivialLastErr = lastErrClean.length < 8;
    if (lastErrClean && !isTrivialLastErr) {
      lines.push("");
      lines.push(muted("Recent Gateway log error (may be from an earlier run):"));
      emitDetail(redactStatusSecrets(lastErrClean));
    }

    if (diagnosis.portUsage) {
      const benignDualStackLoopback = isDualStackLoopbackGatewayListeners(
        diagnosis.portUsage.listeners,
        diagnosis.port,
      );
      const expectedGatewayListeners = isExpectedGatewayListeners(
        diagnosis.portUsage.listeners,
        diagnosis.port,
      );
      const portOk =
        diagnosis.portUsage.status === "free" ||
        (diagnosis.portUsage.status === "busy" && expectedGatewayListeners);
      emitCheck(`Port ${diagnosis.port}`, portOk ? "ok" : "warn");
      if (!portOk) {
        const gatewayPidCount = countGatewayListenerPids(diagnosis.portUsage);
        if (gatewayPidCount > 1) {
          emitDetail(
            `${gatewayPidCount} OpenClaw gateway processes appear to be listening on port ${diagnosis.port}; stop stale gateway processes before trusting channel health.`,
          );
        }
        for (const line of formatPortDiagnostics(diagnosis.portUsage)) {
          emitDetail(line);
        }
      } else if (benignDualStackLoopback) {
        emitDetail(
          "Detected dual-stack loopback listeners (127.0.0.1 + ::1) for one gateway process.",
        );
      } else if (expectedGatewayListeners) {
        emitDetail("Detected OpenClaw Gateway listener on the configured port.");
      }
    }

    emitCheck(
      `Tailscale exposure: ${diagnosis.tailscaleMode} · daemon unknown${diagnosis.tailscaleDns ? ` · ${diagnosis.tailscaleDns}` : ""}`,
      diagnosis.tailscaleMode === "off" ? "ok" : "warn",
    );
    if (diagnosis.tailscaleHttpsUrl) {
      emitDetail(`https: ${diagnosis.tailscaleHttpsUrl}`);
    }

    if (diagnosis.skillReadiness) {
      const { eligible, missing, workspaceDir } = diagnosis.skillReadiness;
      emitCheck(
        `Skills: ${eligible} eligible · ${missing} missing · ${workspaceDir}`,
        missing === 0 ? "ok" : "warn",
      );
    }

    emitCheck(
      `Plugin compatibility (${diagnosis.pluginCompatibility.length || "none"})`,
      diagnosis.pluginCompatibility.length === 0 ? "ok" : "warn",
    );
    emitLimited(diagnosis.pluginCompatibility, 12, (notice) => {
      const severity = notice.severity === "warn" ? "warn" : "info";
      return `  - [${severity}] ${formatPluginCompatibilityNotice(notice)}`;
    });

    if (agentStatus) {
      const recentSessions = countActiveStatusAgents({
        agentStatus,
        activeThresholdMs: AGENT_ACTIVITY_SOFT_WARNING_MS,
      });
      const hasKnownSessions = agentStatus.totalSessions > 0;
      const shouldWarn = hasKnownSessions && recentSessions === 0;
      emitCheck(
        `Agent activity: ${recentSessions} active in 30m · ${agentStatus.totalSessions} sessions`,
        shouldWarn ? "warn" : "ok",
      );
      if (shouldWarn) {
        emitDetail(
          "No agent session was updated in the last 30m; if channels received messages, verify inbound dispatch and turn creation.",
        );
      }
    }

    if (!diagnosis.nodeOnlyGateway && diagnosis.exporterDiagnostics) {
      if (diagnosis.exporterDiagnostics.ok) {
        const exporterSummary = formatTelemetryExporterSummary(diagnosis.exporterDiagnostics.value);
        if (exporterSummary) {
          emitCheck(exporterSummary.title, exporterSummary.status);
          for (const line of exporterSummary.lines) {
            emitDetail(line);
          }
        }
      } else {
        emitUnavailableDiagnostics({
          label: "Telemetry exporters",
          detail: `Exporter diagnostics failed: ${diagnosis.exporterDiagnostics.error}`,
          retry: "openclaw gateway stability --type telemetry.exporter",
        });
      }
    }

    if (!diagnosis.nodeOnlyGateway && diagnosis.deliveryDiagnostics) {
      const diagnostic = diagnosis.deliveryDiagnostics;
      if (!diagnostic.ok || !isDeliveryDiagnosticsLike(diagnostic.value)) {
        emitUnavailableDiagnostics({
          label: "Inbound delivery telemetry",
          detail: diagnostic.ok
            ? "Delivery diagnostics returned an invalid response."
            : `Delivery diagnostics failed: ${diagnostic.error}`,
          retry: "openclaw gateway stability",
        });
      } else {
        const deliveryDiagnostics = diagnostic.value;
        const received = countDeliveryEvent(deliveryDiagnostics, "message.received");
        const dispatchStarted = countDeliveryEvent(deliveryDiagnostics, "message.dispatch.started");
        const dispatchCompleted = countDeliveryEvent(
          deliveryDiagnostics,
          "message.dispatch.completed",
        );
        const turnsCreated = countDeliveryEvent(deliveryDiagnostics, "session.turn.created");
        const processed = countDeliveryEvent(deliveryDiagnostics, "message.processed");
        const hasReceivedWithoutDispatch = received > 0 && dispatchStarted === 0 && processed === 0;
        const hasDispatchWithoutTurn =
          dispatchStarted > 0 && turnsCreated === 0 && processed < dispatchStarted;
        const dispatchGap = dispatchStarted - dispatchCompleted;
        const hasDispatchGap = dispatchGap >= 2;
        const latestAgeMs = latestDeliveryEventAgeMs(deliveryDiagnostics);
        emitCheck(
          `Inbound delivery telemetry: received ${received} · dispatch ${dispatchStarted}/${dispatchCompleted} · turns ${turnsCreated} · processed ${processed}`,
          hasReceivedWithoutDispatch || hasDispatchWithoutTurn || hasDispatchGap ? "warn" : "ok",
        );
        if (latestAgeMs != null) {
          emitDetail(`latest delivery event: ${formatTimeAgo(latestAgeMs)}`);
        }
        if (hasReceivedWithoutDispatch) {
          emitDetail(
            "Messages were received, but no gateway dispatch started; inspect inbound routing and dispatch handoff.",
          );
        }
        if (hasDispatchWithoutTurn) {
          emitDetail(
            "Gateway dispatch started, but no agent turn was created; inspect reply resolver and session creation.",
          );
        }
        if (hasDispatchGap) {
          emitDetail(
            "Multiple gateway dispatches have not completed yet; if this persists, inspect stuck sessions or model runs.",
          );
        }
      }
    }

    if (logTails) {
      const { logPaths, restartLogPath, readStderr, stderrTail, stdoutTail, restartTail } =
        logTails;
      if (stderrTail.length > 0 || stdoutTail.length > 0) {
        lines.push("");
        lines.push(muted(`Gateway logs (tail, summarized): ${logPaths.logDir}`));
        for (const [stream, filePath, tail] of [
          ...(readStderr ? [["stderr", logPaths.stderrPath, stderrTail] as const] : []),
          ["stdout", logPaths.stdoutPath, stdoutTail] as const,
        ]) {
          emitDetail(`# ${stream}: ${filePath}`);
          for (const line of summarizeLogTail(tail, { maxLines: 22 }).map(redactStatusSecrets)) {
            emitDetail(line);
          }
        }
      }
      if (restartTail.length > 0) {
        lines.push("");
        lines.push(muted(`Gateway restart attempts (tail): ${restartLogPath}`));
        for (const line of summarizeLogTail(restartTail, { maxLines: 16 }).map(
          redactStatusSecrets,
        )) {
          emitDetail(line);
        }
      }
    }
    progress.tick();

    if (diagnosis.channelsStatus) {
      emitCheck(
        `Channel issues (${diagnosis.channelIssues.length || "none"})`,
        diagnosis.channelIssues.length === 0 ? "ok" : "warn",
      );
      emitLimited(diagnosis.channelIssues, 12, (issue) => {
        const fixText = issue.fix ? ` · fix: ${issue.fix}` : "";
        return `  - ${issue.channel}[${issue.accountId}] ${issue.kind}: ${issue.message}${fixText}`;
      });
    } else if (diagnosis.nodeOnlyGateway) {
      emitCheck(
        `Channel issues skipped (node-only mode; query ${diagnosis.nodeOnlyGateway.gatewayTarget})`,
        "ok",
      );
    } else if (diagnosis.gatewayStartupPhase) {
      emitCheck(
        `Channel issues skipped (gateway still starting (phase ${diagnosis.gatewayStartupPhase}))`,
        "ok",
      );
    } else {
      emitCheck(
        `Channel issues skipped (gateway ${diagnosis.gatewayReachable ? "query failed" : "unreachable"})`,
        "warn",
      );
    }

    if (diagnosis.health) {
      if ("error" in diagnosis.health) {
        if (diagnosis.health.error) {
          lines.push("");
          lines.push(muted("Gateway health:"));
          emitDetail(redactStatusSecrets(diagnosis.health.error));
        }
      } else {
        const deliveryQueueLine = formatDeliveryQueueHealthLine(diagnosis.health);
        if (deliveryQueueLine) {
          emitCheck(redactStatusSecrets(deliveryQueueLine), "warn");
        }
      }
    }

    lines.push("");
    lines.push(muted("Pasteable debug report. Auth tokens redacted."));
    lines.push("Troubleshooting: https://docs.openclaw.ai/troubleshooting");
    lines.push("");

    if (usage) {
      lines.push("", ...formatUsageReportLines(usage));
    }

    progress.setLabel("Rendering…");
    runtime.log(lines.join("\n"));
    progress.tick();
  });
}
