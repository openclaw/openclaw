import { withProgress } from "../cli/progress.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { resolveStatusJsonOutput } from "./status-json-runtime.ts";
import {
  loadStatusProviderUsageModule,
  resolveStatusGatewayHealth,
  resolveStatusRuntimeDetails,
  resolveStatusSecurityAudit,
  resolveStatusUsageSummary,
} from "./status-runtime-shared.ts";
import { buildStatusCommandReportLines } from "./status.command-report.ts";
import {
  buildStatusAgentsValue,
  buildStatusFooterLines,
  buildStatusHealthRows,
  buildStatusHeartbeatValue,
  buildStatusLastHeartbeatValue,
  buildStatusMemoryValue,
  buildStatusPairingRecoveryLines,
  buildStatusPluginCompatibilityLines,
  buildStatusSecurityAuditLines,
  buildStatusSessionsRows,
  buildStatusSystemEventsRows,
  buildStatusSystemEventsTrailer,
  buildStatusTasksValue,
  statusHealthColumns,
} from "./status.command-sections.ts";

let statusScanModulePromise: Promise<typeof import("./status.scan.js")> | undefined;
let statusScanFastJsonModulePromise:
  | Promise<typeof import("./status.scan.fast-json.js")>
  | undefined;
let statusAllModulePromise: Promise<typeof import("./status-all.js")> | undefined;
let statusCommandTextRuntimePromise:
  | Promise<typeof import("./status.command.text-runtime.js")>
  | undefined;
let statusNodeModeModulePromise: Promise<typeof import("./status.node-mode.js")> | undefined;

function loadStatusScanModule() {
  statusScanModulePromise ??= import("./status.scan.js");
  return statusScanModulePromise;
}

function loadStatusScanFastJsonModule() {
  statusScanFastJsonModulePromise ??= import("./status.scan.fast-json.js");
  return statusScanFastJsonModulePromise;
}

function loadStatusAllModule() {
  statusAllModulePromise ??= import("./status-all.js");
  return statusAllModulePromise;
}

function loadStatusCommandTextRuntime() {
  statusCommandTextRuntimePromise ??= import("./status.command.text-runtime.js");
  return statusCommandTextRuntimePromise;
}

function loadStatusNodeModeModule() {
  statusNodeModeModulePromise ??= import("./status.node-mode.js");
  return statusNodeModeModulePromise;
}

function resolvePairingRecoveryContext(params: {
  error?: string | null;
  closeReason?: string | null;
}): { requestId: string | null } | null {
  const sanitizeRequestId = (value: string): string | null => {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    // Keep CLI guidance injection-safe: allow only compact id characters.
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(trimmed)) {
      return null;
    }
    return trimmed;
  };
  const source = [params.error, params.closeReason]
    .filter((part) => typeof part === "string" && part.trim().length > 0)
    .join(" ");
  if (!source || !/pairing required/i.test(source)) {
    return null;
  }
  const requestIdMatch = source.match(/requestId:\s*([^\s)]+)/i);
  const requestId =
    requestIdMatch && requestIdMatch[1] ? sanitizeRequestId(requestIdMatch[1]) : null;
  return { requestId: requestId || null };
}

export async function statusCommand(
  opts: {
    json?: boolean;
    deep?: boolean;
    usage?: boolean;
    timeoutMs?: number;
    verbose?: boolean;
    all?: boolean;
  },
  runtime: RuntimeEnv,
) {
  if (opts.all && !opts.json) {
    await loadStatusAllModule().then(({ statusAllCommand }) =>
      statusAllCommand(runtime, { timeoutMs: opts.timeoutMs }),
    );
    return;
  }

  const scan = opts.json
    ? await loadStatusScanFastJsonModule().then(({ scanStatusJsonFast }) =>
        scanStatusJsonFast({ timeoutMs: opts.timeoutMs, all: opts.all }, runtime),
      )
    : await loadStatusScanModule().then(({ scanStatus }) =>
        scanStatus({ json: false, timeoutMs: opts.timeoutMs, all: opts.all }, runtime),
      );
  if (opts.json) {
    writeRuntimeJson(
      runtime,
      await resolveStatusJsonOutput({
        scan,
        opts,
        includeSecurityAudit: true,
        includePluginCompatibility: true,
      }),
    );
    return;
  }

  const runSecurityAudit = async () =>
    await resolveStatusSecurityAudit({
      config: scan.cfg,
      sourceConfig: scan.sourceConfig,
    });
  const securityAudit = opts.json
    ? await runSecurityAudit()
    : await withProgress(
        {
          label: "Running security audit…",
          indeterminate: true,
          enabled: true,
        },
        async () => await runSecurityAudit(),
      );
  const {
    cfg,
    osSummary,
    tailscaleMode,
    tailscaleDns,
    tailscaleHttpsUrl,
    update,
    gatewayConnection,
    remoteUrlMissing,
    gatewayMode,
    gatewayProbeAuth,
    gatewayProbeAuthWarning,
    gatewayProbe,
    gatewayReachable,
    gatewaySelf,
    channelIssues,
    agentStatus,
    channels,
    summary,
    secretDiagnostics,
    memory,
    memoryPlugin,
    pluginCompatibility,
  } = scan;

  const {
    usage,
    health,
    lastHeartbeat,
    gatewayService: daemon,
    nodeService: nodeDaemon,
  } = await resolveStatusRuntimeDetails({
    config: scan.cfg,
    timeoutMs: opts.timeoutMs,
    usage: opts.usage,
    deep: opts.deep,
    gatewayReachable,
    resolveUsage: async (timeoutMs) =>
      await withProgress(
        {
          label: "Fetching usage snapshot…",
          indeterminate: true,
          enabled: opts.json !== true,
        },
        async () => await resolveStatusUsageSummary(timeoutMs),
      ),
    resolveHealth: async (input) =>
      await withProgress(
        {
          label: "Checking gateway health…",
          indeterminate: true,
          enabled: opts.json !== true,
        },
        async () => await resolveStatusGatewayHealth(input),
      ),
  });

  const rich = true;
  const {
    buildStatusGatewaySurfaceValues,
    buildStatusChannelsTableRows,
    buildStatusOverviewRows,
    buildStatusUpdateSurface,
    formatCliCommand,
    formatStatusDashboardValue,
    formatHealthChannelLines,
    formatKTokens,
    formatPromptCacheCompact,
    formatPluginCompatibilityNotice,
    formatStatusTailscaleValue,
    formatTimeAgo,
    formatTokensCompact,
    formatUpdateAvailableHint,
    getTerminalTableWidth,
    info,
    renderTable,
    resolveMemoryCacheSummary,
    resolveMemoryFtsState,
    resolveMemoryVectorState,
    shortenText,
    statusChannelsTableColumns,
    summarizePluginCompatibility,
    theme,
  } = await loadStatusCommandTextRuntime();
  const muted = (value: string) => (rich ? theme.muted(value) : value);
  const ok = (value: string) => (rich ? theme.success(value) : value);
  const warn = (value: string) => (rich ? theme.warn(value) : value);
  const updateSurface = buildStatusUpdateSurface({
    updateConfigChannel: cfg.update?.channel,
    update,
  });

  if (opts.verbose) {
    const { buildGatewayConnectionDetails } = await import("../gateway/call.js");
    const details = buildGatewayConnectionDetails({ config: scan.cfg });
    runtime.log(info("Gateway connection:"));
    for (const line of details.message.split("\n")) {
      runtime.log(`  ${line}`);
    }
    runtime.log("");
  }

  const tableWidth = getTerminalTableWidth();

  if (secretDiagnostics.length > 0) {
    runtime.log(theme.warn("Secret diagnostics:"));
    for (const entry of secretDiagnostics) {
      runtime.log(`- ${entry}`);
    }
    runtime.log("");
  }

  const nodeOnlyGateway = await loadStatusNodeModeModule().then(({ resolveNodeOnlyGatewayInfo }) =>
    resolveNodeOnlyGatewayInfo({
      daemon,
      node: nodeDaemon,
    }),
  );
  const { dashboardUrl, gatewayValue, gatewayServiceValue, nodeServiceValue } =
    buildStatusGatewaySurfaceValues({
      cfg,
      gatewayMode,
      remoteUrlMissing,
      gatewayConnection,
      gatewayReachable,
      gatewayProbe,
      gatewayProbeAuth,
      gatewaySelf,
      gatewayService: daemon,
      nodeService: nodeDaemon,
      nodeOnlyGateway,
      decorateOk: ok,
      decorateWarn: warn,
    });
  const pairingRecovery = resolvePairingRecoveryContext({
    error: gatewayProbe?.error ?? null,
    closeReason: gatewayProbe?.close?.reason ?? null,
  });

  const agentsValue = buildStatusAgentsValue({ agentStatus, formatTimeAgo });

  const defaults = summary.sessions.defaults;
  const defaultCtx = defaults.contextTokens
    ? ` (${formatKTokens(defaults.contextTokens)} ctx)`
    : "";
  const eventsValue =
    summary.queuedSystemEvents.length > 0 ? `${summary.queuedSystemEvents.length} queued` : "none";
  const tasksValue = buildStatusTasksValue({ summary, warn, muted });

  const probesValue = health ? ok("enabled") : muted("skipped (use --deep)");

  const heartbeatValue = buildStatusHeartbeatValue({ summary });
  const lastHeartbeatValue = buildStatusLastHeartbeatValue({
    deep: opts.deep,
    gatewayReachable,
    lastHeartbeat,
    warn,
    muted,
    formatTimeAgo,
  });

  const storeLabel =
    summary.sessions.paths.length > 1
      ? `${summary.sessions.paths.length} stores`
      : (summary.sessions.paths[0] ?? "unknown");

  const memoryValue = buildStatusMemoryValue({
    memory,
    memoryPlugin,
    ok,
    warn,
    muted,
    resolveMemoryVectorState,
    resolveMemoryFtsState,
    resolveMemoryCacheSummary,
  });

  const channelLabel = updateSurface.channelLabel;
  const gitLabel = updateSurface.gitLabel;
  const pluginCompatibilitySummary = summarizePluginCompatibility(pluginCompatibility);
  const pluginCompatibilityValue =
    pluginCompatibilitySummary.noticeCount === 0
      ? ok("none")
      : warn(
          `${pluginCompatibilitySummary.noticeCount} notice${pluginCompatibilitySummary.noticeCount === 1 ? "" : "s"} · ${pluginCompatibilitySummary.pluginCount} plugin${pluginCompatibilitySummary.pluginCount === 1 ? "" : "s"}`,
        );

  const overviewRows = buildStatusOverviewRows({
    prefixRows: [{ Item: "OS", Value: `${osSummary.label} · node ${process.versions.node}` }],
    dashboardValue: formatStatusDashboardValue(dashboardUrl),
    tailscaleValue: formatStatusTailscaleValue({
      tailscaleMode,
      dnsName: tailscaleDns,
      httpsUrl: tailscaleHttpsUrl,
      decorateOff: muted,
      decorateWarn: warn,
    }),
    channelLabel,
    gitLabel,
    updateValue: updateSurface.updateAvailable
      ? warn(`available · ${updateSurface.updateLine}`)
      : updateSurface.updateLine,
    gatewayValue,
    gatewayAuthWarning: gatewayProbeAuthWarning ? warn(gatewayProbeAuthWarning) : null,
    gatewayServiceValue,
    nodeServiceValue,
    agentsValue,
    suffixRows: [
      { Item: "Memory", Value: memoryValue },
      { Item: "Plugin compatibility", Value: pluginCompatibilityValue },
      { Item: "Probes", Value: probesValue },
      { Item: "Events", Value: eventsValue },
      { Item: "Tasks", Value: tasksValue },
      { Item: "Heartbeat", Value: heartbeatValue },
      ...(lastHeartbeatValue ? [{ Item: "Last heartbeat", Value: lastHeartbeatValue }] : []),
      {
        Item: "Sessions",
        Value: `${summary.sessions.count} active · default ${defaults.model ?? "unknown"}${defaultCtx} · ${storeLabel}`,
      },
    ],
  });
  const securityAuditLines = buildStatusSecurityAuditLines({
    securityAudit,
    theme,
    shortenText,
    formatCliCommand,
  });

  const sessionsColumns = [
    { key: "Key", header: "Key", minWidth: 20, flex: true },
    { key: "Kind", header: "Kind", minWidth: 6 },
    { key: "Age", header: "Age", minWidth: 9 },
    { key: "Model", header: "Model", minWidth: 14 },
    { key: "Tokens", header: "Tokens", minWidth: 16 },
    ...(opts.verbose ? [{ key: "Cache", header: "Cache", minWidth: 16, flex: true }] : []),
  ];
  const sessionsRows = buildStatusSessionsRows({
    recent: summary.sessions.recent,
    verbose: opts.verbose,
    shortenText,
    formatTimeAgo,
    formatTokensCompact,
    formatPromptCacheCompact,
    muted,
  });
  const healthRows = health
    ? buildStatusHealthRows({
        health,
        formatHealthChannelLines,
        ok,
        warn,
        muted,
      })
    : undefined;
  const usageLines = usage
    ? await loadStatusProviderUsageModule().then(({ formatUsageReportLines }) =>
        formatUsageReportLines(usage),
      )
    : undefined;
  const updateHint = formatUpdateAvailableHint(update);
  const lines = await buildStatusCommandReportLines({
    heading: theme.heading,
    muted: theme.muted,
    renderTable,
    width: tableWidth,
    overviewRows,
    showTaskMaintenanceHint: summary.taskAudit.errors > 0,
    taskMaintenanceHint: `Task maintenance: ${formatCliCommand("openclaw tasks maintenance --apply")}`,
    pluginCompatibilityLines: buildStatusPluginCompatibilityLines({
      notices: pluginCompatibility,
      formatNotice: formatPluginCompatibilityNotice,
      warn: theme.warn,
      muted: theme.muted,
    }),
    pairingRecoveryLines: buildStatusPairingRecoveryLines({
      pairingRecovery,
      warn: theme.warn,
      muted: theme.muted,
      formatCliCommand,
    }),
    securityAuditLines,
    channelsColumns: statusChannelsTableColumns,
    channelsRows: buildStatusChannelsTableRows({
      rows: channels.rows,
      channelIssues,
      ok,
      warn,
      muted,
      accentDim: theme.accentDim,
      formatIssueMessage: (message) => shortenText(message, 84),
    }),
    sessionsColumns,
    sessionsRows,
    systemEventsRows: buildStatusSystemEventsRows({
      queuedSystemEvents: summary.queuedSystemEvents,
    }),
    systemEventsTrailer: buildStatusSystemEventsTrailer({
      queuedSystemEvents: summary.queuedSystemEvents,
      muted,
    }),
    healthColumns: health ? statusHealthColumns : undefined,
    healthRows,
    usageLines,
    footerLines: buildStatusFooterLines({
      updateHint,
      warn: theme.warn,
      formatCliCommand,
      nodeOnlyGateway,
      gatewayReachable,
    }),
  });
  for (const line of lines) {
    runtime.log(line);
  }
}
