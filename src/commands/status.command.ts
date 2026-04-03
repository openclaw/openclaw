import { withProgress } from "../cli/progress.js";
import type { HeartbeatEventPayload } from "../infra/heartbeat-events.js";
import { normalizeUpdateChannel, resolveUpdateChannelDisplay } from "../infra/update-channels.js";
import { formatGitInstallLabel } from "../infra/update-check.js";
import {
  resolveMemoryCacheSummary,
  resolveMemoryFtsState,
  resolveMemoryVectorState,
  type Tone,
} from "../memory/status-format.js";
import {
  buildPluginRuntimeNotices,
  buildPluginRuntimeSummaries,
  formatPluginCompatibilityNotice,
  summarizePluginCompatibility,
} from "../plugins/status.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import type { HealthSummary } from "./health.js";
import { getDaemonStatusSummary, getNodeDaemonStatusSummary } from "./status.daemon.js";

let providerUsagePromise: Promise<typeof import("../infra/provider-usage.js")> | undefined;
let securityAuditModulePromise: Promise<typeof import("../security/audit.runtime.js")> | undefined;
let gatewayCallModulePromise: Promise<typeof import("../gateway/call.js")> | undefined;
let statusScanModulePromise: Promise<typeof import("./status.scan.js")> | undefined;
let statusScanFastJsonModulePromise:
  | Promise<typeof import("./status.scan.fast-json.js")>
  | undefined;
let statusAllModulePromise: Promise<typeof import("./status-all.js")> | undefined;
let statusCommandTextRuntimePromise:
  | Promise<typeof import("./status.command.text-runtime.js")>
  | undefined;
let statusNodeModeModulePromise: Promise<typeof import("./status.node-mode.js")> | undefined;

function loadProviderUsage() {
  providerUsagePromise ??= import("../infra/provider-usage.js");
  return providerUsagePromise;
}

function loadSecurityAuditModule() {
  securityAuditModulePromise ??= import("../security/audit.runtime.js");
  return securityAuditModulePromise;
}

function loadGatewayCallModule() {
  gatewayCallModulePromise ??= import("../gateway/call.js");
  return gatewayCallModulePromise;
}

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
  const runSecurityAudit = async () =>
    await loadSecurityAuditModule().then(({ runSecurityAudit }) =>
      runSecurityAudit({
        config: scan.cfg,
        sourceConfig: scan.sourceConfig,
        deep: false,
        includeFilesystem: true,
        includeChannelSecurity: true,
      }),
    );
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

  const usage = opts.usage
    ? await withProgress(
        {
          label: "Fetching usage snapshot…",
          indeterminate: true,
          enabled: opts.json !== true,
        },
        async () => {
          const { loadProviderUsageSummary } = await loadProviderUsage();
          return await loadProviderUsageSummary({ timeoutMs: opts.timeoutMs });
        },
      )
    : undefined;
  const health: HealthSummary | undefined = opts.deep
    ? await withProgress(
        {
          label: "Checking gateway health…",
          indeterminate: true,
          enabled: opts.json !== true,
        },
        async () => {
          const { callGateway } = await loadGatewayCallModule();
          return await callGateway<HealthSummary>({
            method: "health",
            params: { probe: true },
            timeoutMs: opts.timeoutMs,
            config: scan.cfg,
          });
        },
      )
    : undefined;
  const lastHeartbeat =
    opts.deep && gatewayReachable
      ? await loadGatewayCallModule()
          .then(({ callGateway }) =>
            callGateway<HeartbeatEventPayload | null>({
              method: "last-heartbeat",
              params: {},
              timeoutMs: opts.timeoutMs,
              config: scan.cfg,
            }),
          )
          .catch(() => null)
      : null;

  const configChannel = normalizeUpdateChannel(cfg.update?.channel);
  const channelInfo = resolveUpdateChannelDisplay({
    configChannel,
    installKind: update.installKind,
    gitTag: update.git?.tag ?? null,
    gitBranch: update.git?.branch ?? null,
  });

  if (opts.json) {
    const pluginRuntime = buildPluginRuntimeSummaries({ config: cfg, pluginIds: ["openviking"] });
    const [daemon, nodeDaemon] = await Promise.all([
      getDaemonStatusSummary(),
      getNodeDaemonStatusSummary(),
    ]);
    writeRuntimeJson(runtime, {
      ...summary,
      os: osSummary,
      update,
      updateChannel: channelInfo.channel,
      updateChannelSource: channelInfo.source,
      memory,
      memoryPlugin,
      gateway: {
        mode: gatewayMode,
        url: gatewayConnection.url,
        urlSource: gatewayConnection.urlSource,
        misconfigured: remoteUrlMissing,
        reachable: gatewayReachable,
        connectLatencyMs: gatewayProbe?.connectLatencyMs ?? null,
        self: gatewaySelf,
        error: gatewayProbe?.error ?? null,
        authWarning: gatewayProbeAuthWarning ?? null,
      },
      gatewayService: daemon,
      nodeService: nodeDaemon,
      agents: agentStatus,
      securityAudit,
      secretDiagnostics,
      pluginCompatibility: {
        count: pluginCompatibility.length,
        warnings: pluginCompatibility,
      },
      pluginRuntime,
      ...(health || usage || lastHeartbeat ? { health, usage, lastHeartbeat } : {}),
    });
    return;
  }

  const rich = true;
  const {
    formatCliCommand,
    formatDuration,
    formatGatewayAuthUsed,
    formatGitInstallLabel,
    formatHealthChannelLines,
    formatKTokens,
    formatPluginCompatibilityNotice,
    formatTimeAgo,
    formatTokensCompact,
    formatUpdateAvailableHint,
    formatUpdateOneLiner,
    getTerminalTableWidth,
    groupChannelIssuesByChannel,
    info,
    renderTable,
    resolveControlUiLinks,
    resolveGatewayPort,
    resolveMemoryCacheSummary,
    resolveMemoryFtsState,
    resolveMemoryVectorState,
    resolveUpdateAvailability,
    shortenText,
    summarizePluginCompatibility,
    theme,
  } = await loadStatusCommandTextRuntime();
  const muted = (value: string) => (rich ? theme.muted(value) : value);
  const ok = (value: string) => (rich ? theme.success(value) : value);
  const warn = (value: string) => (rich ? theme.warn(value) : value);

  if (opts.verbose) {
    const { buildGatewayConnectionDetails } = await loadGatewayCallModule();
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

  const dashboard =
    (cfg.gateway?.controlUi?.enabled ?? true)
      ? resolveControlUiLinks({
          port: resolveGatewayPort(cfg),
          bind: cfg.gateway?.bind,
          customBindHost: cfg.gateway?.customBindHost,
          basePath: cfg.gateway?.controlUi?.basePath,
        }).httpUrl
      : "disabled";

  const [daemon, nodeDaemon] = await Promise.all([
    getDaemonStatusSummary(),
    getNodeDaemonStatusSummary(),
  ]);
  const nodeOnlyGateway = await loadStatusNodeModeModule().then(({ resolveNodeOnlyGatewayInfo }) =>
    resolveNodeOnlyGatewayInfo({
      daemon,
      node: nodeDaemon,
    }),
  );

  const gatewayValue = (() => {
    if (nodeOnlyGateway) {
      return nodeOnlyGateway.gatewayValue;
    }
    const target = remoteUrlMissing
      ? `fallback ${gatewayConnection.url}`
      : `${gatewayConnection.url}${gatewayConnection.urlSource ? ` (${gatewayConnection.urlSource})` : ""}`;
    const reach = remoteUrlMissing
      ? warn("misconfigured (remote.url missing)")
      : gatewayReachable
        ? ok(`reachable ${formatDuration(gatewayProbe?.connectLatencyMs)}`)
        : warn(gatewayProbe?.error ? `unreachable (${gatewayProbe.error})` : "unreachable");
    const auth =
      gatewayReachable && !remoteUrlMissing
        ? ` · auth ${formatGatewayAuthUsed(gatewayProbeAuth)}`
        : "";
    const self =
      gatewaySelf?.host || gatewaySelf?.version || gatewaySelf?.platform
        ? [
            gatewaySelf?.host ? gatewaySelf.host : null,
            gatewaySelf?.ip ? `(${gatewaySelf.ip})` : null,
            gatewaySelf?.version ? `app ${gatewaySelf.version}` : null,
            gatewaySelf?.platform ? gatewaySelf.platform : null,
          ]
            .filter(Boolean)
            .join(" ")
        : null;
    const suffix = self ? ` · ${self}` : "";
    return `${gatewayMode} · ${target} · ${reach}${auth}${suffix}`;
  })();
  const pairingRecovery = resolvePairingRecoveryContext({
    error: gatewayProbe?.error ?? null,
    closeReason: gatewayProbe?.close?.reason ?? null,
  });

  const agentsValue = (() => {
    const pending =
      agentStatus.bootstrapPendingCount > 0
        ? `${agentStatus.bootstrapPendingCount} bootstrap file${agentStatus.bootstrapPendingCount === 1 ? "" : "s"} present`
        : "no bootstrap files";
    const def = agentStatus.agents.find((a) => a.id === agentStatus.defaultId);
    const defActive = def?.lastActiveAgeMs != null ? formatTimeAgo(def.lastActiveAgeMs) : "unknown";
    const defSuffix = def ? ` · default ${def.id} active ${defActive}` : "";
    return `${agentStatus.agents.length} · ${pending} · sessions ${agentStatus.totalSessions}${defSuffix}`;
  })();
  const daemonValue = (() => {
    if (daemon.installed === false) {
      return `${daemon.label} not installed`;
    }
    const installedPrefix = daemon.managedByOpenClaw ? "installed · " : "";
    return `${daemon.label} ${installedPrefix}${daemon.loadedText}${daemon.runtimeShort ? ` · ${daemon.runtimeShort}` : ""}`;
  })();
  const nodeDaemonValue = (() => {
    if (nodeDaemon.installed === false) {
      return `${nodeDaemon.label} not installed`;
    }
    const installedPrefix = nodeDaemon.managedByOpenClaw ? "installed · " : "";
    return `${nodeDaemon.label} ${installedPrefix}${nodeDaemon.loadedText}${nodeDaemon.runtimeShort ? ` · ${nodeDaemon.runtimeShort}` : ""}`;
  })();

  const defaults = summary.sessions.defaults;
  const defaultCtx = defaults.contextTokens
    ? ` (${formatKTokens(defaults.contextTokens)} ctx)`
    : "";
  const eventsValue =
    summary.queuedSystemEvents.length > 0 ? `${summary.queuedSystemEvents.length} queued` : "none";
  const tasksValue =
    summary.tasks.total > 0
      ? [
          `${summary.tasks.active} active`,
          `${summary.tasks.byStatus.queued} queued`,
          `${summary.tasks.byStatus.running} running`,
          summary.tasks.failures > 0
            ? warn(`${summary.tasks.failures} issue${summary.tasks.failures === 1 ? "" : "s"}`)
            : muted("no issues"),
          summary.taskAudit.errors > 0
            ? warn(
                `audit ${summary.taskAudit.errors} error${summary.taskAudit.errors === 1 ? "" : "s"} · ${summary.taskAudit.warnings} warn`,
              )
            : summary.taskAudit.warnings > 0
              ? muted(`audit ${summary.taskAudit.warnings} warn`)
              : muted("audit clean"),
          `${summary.tasks.total} tracked`,
        ].join(" · ")
      : muted("none");

  const probesValue = health ? ok("enabled") : muted("skipped (use --deep)");

  const heartbeatValue = (() => {
    const parts = summary.heartbeat.agents
      .map((agent) => {
        if (!agent.enabled || !agent.everyMs) {
          return `disabled (${agent.agentId})`;
        }
        const everyLabel = agent.every;
        return `${everyLabel} (${agent.agentId})`;
      })
      .filter(Boolean);
    return parts.length > 0 ? parts.join(", ") : "disabled";
  })();
  const lastHeartbeatValue = (() => {
    if (!opts.deep) {
      return null;
    }
    if (!gatewayReachable) {
      return warn("unavailable");
    }
    if (!lastHeartbeat) {
      return muted("none");
    }
    const age = formatTimeAgo(Date.now() - lastHeartbeat.ts);
    const channel = lastHeartbeat.channel ?? "unknown";
    const accountLabel = lastHeartbeat.accountId ? `account ${lastHeartbeat.accountId}` : null;
    return [lastHeartbeat.status, `${age} ago`, channel, accountLabel].filter(Boolean).join(" · ");
  })();

  const storeLabel =
    summary.sessions.paths.length > 1
      ? `${summary.sessions.paths.length} stores`
      : (summary.sessions.paths[0] ?? "unknown");

  const memoryValue = (() => {
    if (!memoryPlugin.enabled) {
      const suffix = memoryPlugin.reason ? ` (${memoryPlugin.reason})` : "";
      return muted(`disabled${suffix}`);
    }
    if (!memory) {
      const slot = memoryPlugin.slot ? `plugin ${memoryPlugin.slot}` : "plugin";
      return muted(`enabled (${slot}) · unavailable`);
    }
    const parts: string[] = [];
    const dirtySuffix = memory.dirty ? ` · ${warn("dirty")}` : "";
    parts.push(`${memory.files} files · ${memory.chunks} chunks${dirtySuffix}`);
    if (memory.sources?.length) {
      parts.push(`sources ${memory.sources.join(", ")}`);
    }
    if (memoryPlugin.slot) {
      parts.push(`plugin ${memoryPlugin.slot}`);
    }
    const colorByTone = (tone: Tone, text: string) =>
      tone === "ok" ? ok(text) : tone === "warn" ? warn(text) : muted(text);
    const vector = memory.vector;
    if (vector) {
      const state = resolveMemoryVectorState(vector);
      const label = state.state === "disabled" ? "vector off" : `vector ${state.state}`;
      parts.push(colorByTone(state.tone, label));
    }
    const fts = memory.fts;
    if (fts) {
      const state = resolveMemoryFtsState(fts);
      const label = state.state === "disabled" ? "fts off" : `fts ${state.state}`;
      parts.push(colorByTone(state.tone, label));
    }
    const cache = memory.cache;
    if (cache) {
      const summary = resolveMemoryCacheSummary(cache);
      parts.push(colorByTone(summary.tone, summary.text));
    }
    return parts.join(" · ");
  })();

  const updateAvailability = resolveUpdateAvailability(update);
  const updateLine = formatUpdateOneLiner(update).replace(/^Update:\s*/i, "");
  const channelLabel = channelInfo.label;
  const gitLabel = formatGitInstallLabel(update);
  const pluginCompatibilitySummary = summarizePluginCompatibility(pluginCompatibility);
  const pluginRuntime = buildPluginRuntimeSummaries({ config: cfg, pluginIds: ["openviking"] });
  const pluginRuntimeNotices = buildPluginRuntimeNotices({
    config: cfg,
    pluginIds: ["openviking"],
  });
  const pluginCompatibilityValue =
    pluginCompatibilitySummary.noticeCount === 0
      ? ok("none")
      : warn(
          `${pluginCompatibilitySummary.noticeCount} notice${pluginCompatibilitySummary.noticeCount === 1 ? "" : "s"} · ${pluginCompatibilitySummary.pluginCount} plugin${pluginCompatibilitySummary.pluginCount === 1 ? "" : "s"}`,
        );
  const pluginRuntimeValue =
    pluginRuntime.length === 0
      ? muted("none")
      : pluginRuntime[0]?.health === "error"
        ? warn(
            `${pluginRuntime[0].pluginId} issues · ${pluginRuntime[0].snapshot.summary.find((line) => line.startsWith("Results:")) ?? "runtime snapshot"}`,
          )
        : pluginRuntime[0]?.health === "warn"
          ? warn(
              `${pluginRuntime[0].pluginId} warning · ${pluginRuntime[0].snapshot.summary.find((line) => line.startsWith("Results:")) ?? "runtime snapshot"}`,
            )
          : ok(
              `${pluginRuntime[0]?.pluginId} ok · ${
                pluginRuntime[0]?.snapshot.summary.find((line) => line.startsWith("Results:")) ??
                "runtime snapshot"
              }`,
            );

  const overviewRows = [
    { Item: "Dashboard", Value: dashboard },
    { Item: "OS", Value: `${osSummary.label} · node ${process.versions.node}` },
    {
      Item: "Tailscale",
      Value:
        tailscaleMode === "off"
          ? muted("off")
          : tailscaleDns && tailscaleHttpsUrl
            ? `${tailscaleMode} · ${tailscaleDns} · ${tailscaleHttpsUrl}`
            : warn(`${tailscaleMode} · magicdns unknown`),
    },
    { Item: "Channel", Value: channelLabel },
    ...(gitLabel ? [{ Item: "Git", Value: gitLabel }] : []),
    {
      Item: "Update",
      Value: updateAvailability.available ? warn(`available · ${updateLine}`) : updateLine,
    },
    { Item: "Gateway", Value: gatewayValue },
    ...(gatewayProbeAuthWarning
      ? [{ Item: "Gateway auth warning", Value: warn(gatewayProbeAuthWarning) }]
      : []),
    { Item: "Gateway service", Value: daemonValue },
    { Item: "Node service", Value: nodeDaemonValue },
    { Item: "Agents", Value: agentsValue },
    { Item: "Memory", Value: memoryValue },
    { Item: "Plugin compatibility", Value: pluginCompatibilityValue },
    { Item: "Plugin runtime", Value: pluginRuntimeValue },
    { Item: "Probes", Value: probesValue },
    { Item: "Events", Value: eventsValue },
    { Item: "Tasks", Value: tasksValue },
    { Item: "Heartbeat", Value: heartbeatValue },
    ...(lastHeartbeatValue ? [{ Item: "Last heartbeat", Value: lastHeartbeatValue }] : []),
    {
      Item: "Sessions",
      Value: `${summary.sessions.count} active · default ${defaults.model ?? "unknown"}${defaultCtx} · ${storeLabel}`,
    },
  ];

  runtime.log(theme.heading("OpenClaw status"));
  runtime.log("");
  runtime.log(theme.heading("Overview"));
  runtime.log(
    renderTable({
      width: tableWidth,
      columns: [
        { key: "Item", header: "Item", minWidth: 12 },
        { key: "Value", header: "Value", flex: true, minWidth: 32 },
      ],
      rows: overviewRows,
    }).trimEnd(),
  );
  if (summary.taskAudit.errors > 0) {
    runtime.log("");
    runtime.log(
      theme.muted(`Task maintenance: ${formatCliCommand("openclaw tasks maintenance --apply")}`),
    );
  }

  if (pluginCompatibility.length > 0) {
    runtime.log("");
    runtime.log(theme.heading("Plugin compatibility"));
    for (const notice of pluginCompatibility.slice(0, 8)) {
      const label = notice.severity === "warn" ? theme.warn("WARN") : theme.muted("INFO");
      runtime.log(`  ${label} ${formatPluginCompatibilityNotice(notice)}`);
    }
    if (pluginCompatibility.length > 8) {
      runtime.log(theme.muted(`  … +${pluginCompatibility.length - 8} more`));
    }
  }

  if (pluginRuntime.length > 0) {
    runtime.log("");
    runtime.log(theme.heading("Plugin runtime"));
    for (const entry of pluginRuntime) {
      const label =
        entry.health === "error"
          ? theme.error("ERROR")
          : entry.health === "warn"
            ? theme.warn("WARN")
            : theme.success("OK");
      runtime.log(`  ${label} ${entry.pluginId}`);
      for (const line of entry.snapshot.summary) {
        runtime.log(`    ${line}`);
      }
    }
    for (const notice of pluginRuntimeNotices.slice(0, 8)) {
      const label =
        notice.severity === "error"
          ? theme.error("ERROR")
          : notice.severity === "warn"
            ? theme.warn("WARN")
            : theme.muted("INFO");
      runtime.log(`  ${label} ${notice.pluginId} ${notice.message}`);
    }
    if (pluginRuntimeNotices.length > 8) {
      runtime.log(theme.muted(`  … +${pluginRuntimeNotices.length - 8} more`));
    }
  }

  if (pairingRecovery) {
    runtime.log("");
    runtime.log(theme.warn("Gateway pairing approval required."));
    if (pairingRecovery.requestId) {
      runtime.log(
        theme.muted(
          `Recovery: ${formatCliCommand(`openclaw devices approve ${pairingRecovery.requestId}`)}`,
        ),
      );
    }
    runtime.log(theme.muted(`Fallback: ${formatCliCommand("openclaw devices approve --latest")}`));
    runtime.log(theme.muted(`Inspect: ${formatCliCommand("openclaw devices list")}`));
  }

  runtime.log("");
  runtime.log(theme.heading("Security audit"));
  const fmtSummary = (value: { critical: number; warn: number; info: number }) => {
    const parts = [
      theme.error(`${value.critical} critical`),
      theme.warn(`${value.warn} warn`),
      theme.muted(`${value.info} info`),
    ];
    return parts.join(" · ");
  };
  runtime.log(theme.muted(`Summary: ${fmtSummary(securityAudit.summary)}`));
  const importantFindings = securityAudit.findings.filter(
    (f) => f.severity === "critical" || f.severity === "warn",
  );
  if (importantFindings.length === 0) {
    runtime.log(theme.muted("No critical or warn findings detected."));
  } else {
    const severityLabel = (sev: "critical" | "warn" | "info") => {
      if (sev === "critical") {
        return theme.error("CRITICAL");
      }
      if (sev === "warn") {
        return theme.warn("WARN");
      }
      return theme.muted("INFO");
    };
    const sevRank = (sev: "critical" | "warn" | "info") =>
      sev === "critical" ? 0 : sev === "warn" ? 1 : 2;
    const sorted = [...importantFindings].toSorted(
      (a, b) => sevRank(a.severity) - sevRank(b.severity),
    );
    const shown = sorted.slice(0, 6);
    for (const f of shown) {
      runtime.log(`  ${severityLabel(f.severity)} ${f.title}`);
      runtime.log(`    ${shortenText(f.detail.replaceAll("\n", " "), 160)}`);
      if (f.remediation?.trim()) {
        runtime.log(`    ${theme.muted(`Fix: ${f.remediation.trim()}`)}`);
      }
    }
    if (sorted.length > shown.length) {
      runtime.log(theme.muted(`… +${sorted.length - shown.length} more`));
    }
  }
  runtime.log(theme.muted(`Full report: ${formatCliCommand("openclaw security audit")}`));
  runtime.log(theme.muted(`Deep probe: ${formatCliCommand("openclaw security audit --deep")}`));

  runtime.log("");
  runtime.log(theme.heading("Channels"));
  const channelIssuesByChannel = groupChannelIssuesByChannel(channelIssues);
  runtime.log(
    renderTable({
      width: tableWidth,
      columns: [
        { key: "Channel", header: "Channel", minWidth: 10 },
        { key: "Enabled", header: "Enabled", minWidth: 7 },
        { key: "State", header: "State", minWidth: 8 },
        { key: "Detail", header: "Detail", flex: true, minWidth: 24 },
      ],
      rows: channels.rows.map((row) => {
        const issues = channelIssuesByChannel.get(row.id) ?? [];
        const effectiveState = row.state === "off" ? "off" : issues.length > 0 ? "warn" : row.state;
        const issueSuffix =
          issues.length > 0
            ? ` · ${warn(`gateway: ${shortenText(issues[0]?.message ?? "issue", 84)}`)}`
            : "";
        return {
          Channel: row.label,
          Enabled: row.enabled ? ok("ON") : muted("OFF"),
          State:
            effectiveState === "ok"
              ? ok("OK")
              : effectiveState === "warn"
                ? warn("WARN")
                : effectiveState === "off"
                  ? muted("OFF")
                  : theme.accentDim("SETUP"),
          Detail: `${row.detail}${issueSuffix}`,
        };
      }),
    }).trimEnd(),
  );

  runtime.log("");
  runtime.log(theme.heading("Sessions"));
  runtime.log(
    renderTable({
      width: tableWidth,
      columns: [
        { key: "Key", header: "Key", minWidth: 20, flex: true },
        { key: "Kind", header: "Kind", minWidth: 6 },
        { key: "Age", header: "Age", minWidth: 9 },
        { key: "Model", header: "Model", minWidth: 14 },
        { key: "Tokens", header: "Tokens", minWidth: 16 },
      ],
      rows:
        summary.sessions.recent.length > 0
          ? summary.sessions.recent.map((sess) => ({
              Key: shortenText(sess.key, 32),
              Kind: sess.kind,
              Age: sess.updatedAt ? formatTimeAgo(sess.age) : "no activity",
              Model: sess.model ?? "unknown",
              Tokens: formatTokensCompact(sess),
            }))
          : [
              {
                Key: muted("no sessions yet"),
                Kind: "",
                Age: "",
                Model: "",
                Tokens: "",
              },
            ],
    }).trimEnd(),
  );

  if (summary.queuedSystemEvents.length > 0) {
    runtime.log("");
    runtime.log(theme.heading("System events"));
    runtime.log(
      renderTable({
        width: tableWidth,
        columns: [{ key: "Event", header: "Event", flex: true, minWidth: 24 }],
        rows: summary.queuedSystemEvents.slice(0, 5).map((event) => ({
          Event: event,
        })),
      }).trimEnd(),
    );
    if (summary.queuedSystemEvents.length > 5) {
      runtime.log(muted(`… +${summary.queuedSystemEvents.length - 5} more`));
    }
  }

  if (health) {
    runtime.log("");
    runtime.log(theme.heading("Health"));
    const rows: Array<Record<string, string>> = [];
    rows.push({
      Item: "Gateway",
      Status: ok("reachable"),
      Detail: `${health.durationMs}ms`,
    });

    for (const line of formatHealthChannelLines(health, { accountMode: "all" })) {
      const colon = line.indexOf(":");
      if (colon === -1) {
        continue;
      }
      const item = line.slice(0, colon).trim();
      const detail = line.slice(colon + 1).trim();
      const normalized = detail.toLowerCase();
      const status = (() => {
        if (normalized.startsWith("ok")) {
          return ok("OK");
        }
        if (normalized.startsWith("failed")) {
          return warn("WARN");
        }
        if (normalized.startsWith("not configured")) {
          return muted("OFF");
        }
        if (normalized.startsWith("configured")) {
          return ok("OK");
        }
        if (normalized.startsWith("linked")) {
          return ok("LINKED");
        }
        if (normalized.startsWith("not linked")) {
          return warn("UNLINKED");
        }
        return warn("WARN");
      })();
      rows.push({ Item: item, Status: status, Detail: detail });
    }

    runtime.log(
      renderTable({
        width: tableWidth,
        columns: [
          { key: "Item", header: "Item", minWidth: 10 },
          { key: "Status", header: "Status", minWidth: 8 },
          { key: "Detail", header: "Detail", flex: true, minWidth: 28 },
        ],
        rows,
      }).trimEnd(),
    );
  }

  if (usage) {
    const { formatUsageReportLines } = await loadProviderUsage();
    runtime.log("");
    runtime.log(theme.heading("Usage"));
    for (const line of formatUsageReportLines(usage)) {
      runtime.log(line);
    }
  }

  runtime.log("");
  runtime.log("FAQ: https://docs.openclaw.ai/faq");
  runtime.log("Troubleshooting: https://docs.openclaw.ai/troubleshooting");
  runtime.log("");
  const updateHint = formatUpdateAvailableHint(update);
  if (updateHint) {
    runtime.log(theme.warn(updateHint));
    runtime.log("");
  }
  runtime.log("Next steps:");
  runtime.log(`  Need to share?      ${formatCliCommand("openclaw status --all")}`);
  runtime.log(`  Need to debug live? ${formatCliCommand("openclaw logs --follow")}`);
  if (nodeOnlyGateway) {
    runtime.log(`  Need node service?  ${formatCliCommand("openclaw node status")}`);
  } else if (gatewayReachable) {
    runtime.log(`  Need to test channels? ${formatCliCommand("openclaw status --deep")}`);
  } else {
    runtime.log(`  Fix reachability first: ${formatCliCommand("openclaw gateway probe")}`);
  }
}
