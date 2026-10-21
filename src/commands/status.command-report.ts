import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  buildPairingConnectRecoveryTitle,
  describePairingConnectRequirement,
  type ConnectPairingRequiredReason,
} from "../../packages/gateway-protocol/src/connect-error-details.js";
import type { TableColumn } from "../../packages/terminal-core/src/table.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { areRuntimeModelRefsEquivalent } from "../agents/model-runtime-aliases.js";
import { formatCliCommand } from "../cli/command-format.js";
import { formatMissingChildRuntimeWarning } from "../infra/child-runtime-viability.js";
import { formatDurationCompact } from "../infra/format-time/format-duration.js";
import { formatTimeAgo } from "../infra/format-time/format-relative.js";
import type { resolveOsSummary } from "../infra/os-summary.js";
import { formatPluginCompatibilityNotice } from "../plugins/status-compatibility.js";
import type { SecurityAuditReport } from "../security/audit.js";
import { readBackupRunFreshness } from "../state/backup-run-records.js";
import type { StatusSummary } from "../status/summary.js";
import { formatDeliveryQueueHealthLine, formatHealthChannelLines } from "./health-format.js";
import type { HealthSummary } from "./health.js";
import { formatSqliteWalHealthWarning } from "./sqlite-wal-health.js";
import {
  buildStatusChannelsTableRows,
  statusChannelsTableColumns,
} from "./status-all/channels-table.js";
import { statusOverviewTableColumns } from "./status-all/report-tables.js";
import { appendStatusReportLines, appendStatusReportTable } from "./status-all/text-report.js";
import { resolveStatusDatabaseEngines } from "./status-database-engines.js";
import { buildStatusCommandOverviewRows } from "./status-overview-rows.ts";
import { formatPromptCacheCompact, formatTokensCompact } from "./status.format.js";
import type { StatusScanResult } from "./status.scan-result.ts";
import { formatUpdateAvailableHint } from "./status.update.js";
import { shortenText } from "./text-format.js";

const statusHealthColumns: TableColumn[] = [
  { key: "Item", header: "Item", minWidth: 10 },
  { key: "Status", header: "Status", minWidth: 8 },
  { key: "Detail", header: "Detail", flex: true, minWidth: 28 },
];

function buildStatusSecurityAuditLines(params: {
  securityAudit: {
    summary: { critical: number; warn: number; info: number };
    findings: Array<{
      severity: "critical" | "warn" | "info";
      title: string;
      detail: string;
      remediation?: string | null;
    }>;
  };
}) {
  const fmtSummary = (value: { critical: number; warn: number; info: number }) => {
    return [
      theme.error(`${value.critical} critical`),
      theme.warn(`${value.warn} warn`),
      theme.muted(`${value.info} info`),
    ].join(" · ");
  };
  const lines = [theme.muted(`Summary: ${fmtSummary(params.securityAudit.summary)}`)];
  const importantFindings = params.securityAudit.findings.filter(
    (f) => f.severity === "critical" || f.severity === "warn",
  );
  if (importantFindings.length === 0) {
    lines.push(theme.muted("No critical or warn findings detected."));
  } else {
    const severityLabel = (sev: "critical" | "warn" | "info") =>
      sev === "critical"
        ? theme.error("CRITICAL")
        : sev === "warn"
          ? theme.warn("WARN")
          : theme.muted("INFO");
    const sevRank = (sev: "critical" | "warn" | "info") =>
      sev === "critical" ? 0 : sev === "warn" ? 1 : 2;
    const shown = importantFindings
      // Always show critical findings before warnings, regardless of audit insertion order.
      .toSorted((a, b) => sevRank(a.severity) - sevRank(b.severity))
      .slice(0, 6);
    for (const finding of shown) {
      lines.push(`  ${severityLabel(finding.severity)} ${finding.title}`);
      lines.push(`    ${shortenText(finding.detail.replaceAll("\n", " "), 160)}`);
      if (finding.remediation?.trim()) {
        lines.push(`    ${theme.muted(`Fix: ${finding.remediation.trim()}`)}`);
      }
    }
    if (importantFindings.length > shown.length) {
      lines.push(theme.muted(`… +${importantFindings.length - shown.length} more`));
    }
  }
  lines.push(theme.muted(`Full report: ${formatCliCommand("openclaw security audit")}`));
  lines.push(theme.muted(`Deep check: ${formatCliCommand("openclaw security audit --deep")}`));
  return lines;
}

function buildStatusHealthRows(params: {
  health: HealthSummary;
  sqliteWal?: StatusSummary["sqliteWal"];
}) {
  const rows: Array<{ Item: string; Status: string; Detail: string }> = [
    {
      Item: "Gateway",
      Status: theme.success("reachable"),
      Detail: `${params.health.durationMs}ms`,
    },
  ];
  const childRuntimeWarning = params.health.childRuntime
    ? formatMissingChildRuntimeWarning(params.health.childRuntime)
    : undefined;
  if (childRuntimeWarning) {
    rows.push({
      Item: "Gateway runtime",
      Status: theme.warn("WARN"),
      Detail: childRuntimeWarning,
    });
  }
  const sqliteWalWarning = formatSqliteWalHealthWarning(params.sqliteWal);
  if (sqliteWalWarning) {
    rows.push({ Item: "SQLite WAL", Status: theme.warn("WARN"), Detail: sqliteWalWarning });
  }
  if (params.health.eventLoop) {
    rows.push({
      Item: "Event loop",
      Status: params.health.eventLoop.degraded ? theme.warn("WARN") : theme.success("OK"),
      Detail: formatEventLoopHealthDetail(params.health.eventLoop),
    });
  }
  const healthLines = formatHealthChannelLines(params.health, { accountMode: "all" });
  const deliveryQueueLine = formatDeliveryQueueHealthLine(params.health);
  if (deliveryQueueLine) {
    healthLines.push(deliveryQueueLine);
  }
  for (const line of healthLines) {
    const colon = line.indexOf(":");
    if (colon === -1) {
      continue;
    }
    const item = line.slice(0, colon).trim();
    const detail = line.slice(colon + 1).trim();
    const normalized = normalizeLowercaseStringOrEmpty(detail);
    // Shared health text uses known prefixes to classify table status chips.
    const status =
      normalized === "healthy" || normalized.startsWith("ok") || normalized.startsWith("configured")
        ? theme.success("OK")
        : normalized.startsWith("not configured") || normalized.startsWith("disabled")
          ? theme.muted("OFF")
          : normalized.startsWith("linked")
            ? theme.success("LINKED")
            : normalized.startsWith("not linked")
              ? theme.warn("UNLINKED")
              : theme.warn("WARN");
    rows.push({ Item: item, Status: status, Detail: detail });
  }
  return rows;
}

function formatEventLoopHealthDetail(eventLoop: NonNullable<HealthSummary["eventLoop"]>): string {
  const parts = [
    eventLoop.degraded && eventLoop.degradedSinceMs != null
      ? `degraded for ${formatDurationCompact(eventLoop.degradedSinceMs) ?? "0s"}`
      : null,
    eventLoop.reasons.length > 0 ? `reasons ${eventLoop.reasons.join(",")}` : "healthy",
    `max ${Math.round(eventLoop.delayMaxMs)}ms`,
    `p99 ${Math.round(eventLoop.delayP99Ms)}ms`,
    `util ${eventLoop.utilization}`,
    `cpu ${eventLoop.cpuCoreRatio}`,
  ];
  return parts.filter((part): part is string => part !== null).join(" · ");
}

/** Explains sessions pinned to a selected model different from the current configured default. */
function buildStatusModelSelectionLines(recent: StatusSummary["sessions"]["recent"]) {
  const mismatches = recent.filter((sess) => {
    if (!sess.configuredModel || !sess.selectedModel || !sess.modelSelectionReason) {
      return false;
    }
    return (
      sess.configuredModel !== sess.selectedModel &&
      // Runtime aliases such as provider-qualified model refs should not warn as real mismatches.
      !areRuntimeModelRefsEquivalent(sess.configuredModel, sess.selectedModel)
    );
  });
  if (mismatches.length === 0) {
    return [];
  }

  const lines: string[] = [];
  for (const sess of mismatches.slice(0, 3)) {
    const key = shortenText(sess.key, 48);
    const configured = sess.configuredModel ?? "unknown";
    const selected = sess.selectedModel ?? "unknown";
    const isFallback = sess.modelSelectionReason === "fallback selected";
    const intro = isFallback
      ? `Session ${key} is running ${selected} (auto fallback); config primary is ${configured}.`
      : `Session ${key} is pinned to ${selected}; config primary ${configured} will apply to new/unpinned sessions.`;
    const reasonLine = `  Reason: ${sess.modelSelectionReason ?? "session override"}`;
    const clearLine = isFallback
      ? "  Action: check provider availability or retry with /model"
      : "  Clear with: /model default";
    lines.push(
      theme.warn(intro),
      `  Configured default: ${configured}`,
      `  Session selected: ${selected}`,
      reasonLine,
      clearLine,
      "  Docs: https://docs.openclaw.ai/concepts/models#selection-source-and-fallback-strictness",
    );
  }
  if (mismatches.length > 3) {
    lines.push(theme.muted(`  … +${mismatches.length - 3} more pinned session(s)`));
  }
  return lines;
}

export async function buildStatusCommandReportLines(
  input: Omit<
    Parameters<typeof buildStatusCommandOverviewRows>[0],
    "backupFreshness" | "osLabel"
  > & {
    publish?: StatusScanResult["publish"];
    opts: { deep?: boolean; verbose?: boolean };
    osSummary: ReturnType<typeof resolveOsSummary>;
    securityAudit?: SecurityAuditReport;
    usageLines?: string[];
    channels: {
      rows: Array<Parameters<typeof buildStatusChannelsTableRows>[0]["rows"][number]>;
    };
    channelIssues: Array<
      Parameters<typeof buildStatusChannelsTableRows>[0]["channelIssues"][number]
    >;
    pairingRecovery: {
      requestId: string | null;
      reason: ConnectPairingRequiredReason | null;
      remediationHint: string | null;
    } | null;
    tableWidth: number;
  },
) {
  const databaseEngines = await resolveStatusDatabaseEngines(
    input.surface.cfg,
    input.summary.databaseStores,
  );
  const backupFreshness = await readBackupRunFreshness(input.env);
  const published = input.publish?.();
  const params = {
    ...input,
    ...published,
    surface: { ...input.surface, ...published, databaseEngines },
  };
  const overviewRows = buildStatusCommandOverviewRows({
    ...params,
    backupFreshness,
    osLabel: params.osSummary.label,
  });

  const sessionsColumns = [
    { key: "Key", header: "Key", minWidth: 20, flex: true },
    { key: "Kind", header: "Kind", minWidth: 6 },
    { key: "Age", header: "Age", minWidth: 9 },
    { key: "Model", header: "Model", minWidth: 14 },
    { key: "Runtime", header: "Runtime", minWidth: 14 },
    { key: "Tokens", header: "Tokens", minWidth: 16 },
    // Verbose mode exposes prompt-cache details because it can widen rows substantially.
    ...(params.opts.verbose ? [{ key: "Cache", header: "Cache", minWidth: 16, flex: true }] : []),
  ] satisfies TableColumn[];
  const securityAuditLines = params.securityAudit
    ? buildStatusSecurityAuditLines({
        securityAudit: params.securityAudit,
      })
    : [
        theme.muted(
          `Skipped in fast status. Full report: ${formatCliCommand("openclaw security audit")}`,
        ),
        theme.muted(`Deep check: ${formatCliCommand("openclaw status --deep")}`),
      ];
  const width = params.tableWidth;
  const pluginCompatibilityLines =
    params.pluginCompatibility.length === 0
      ? []
      : [
          ...params.pluginCompatibility.slice(0, 8).map((notice) => {
            const label = notice.severity === "warn" ? theme.warn("WARN") : theme.muted("INFO");
            return `  ${label} ${formatPluginCompatibilityNotice(notice)}`;
          }),
          ...(params.pluginCompatibility.length > 8
            ? [theme.muted(`  … +${params.pluginCompatibility.length - 8} more`)]
            : []),
        ];
  const pairingRecoveryLines = params.pairingRecovery
    ? [
        theme.warn(buildPairingConnectRecoveryTitle(params.pairingRecovery.reason ?? undefined)),
        ...(params.pairingRecovery.reason
          ? [
              theme.muted(
                `Reason: ${describePairingConnectRequirement(params.pairingRecovery.reason)}.`,
              ),
            ]
          : []),
        ...(params.pairingRecovery.remediationHint
          ? [theme.muted(`Hint: ${params.pairingRecovery.remediationHint}`)]
          : []),
        ...(params.pairingRecovery.requestId
          ? [
              theme.muted(
                `Recovery: ${formatCliCommand(`openclaw devices approve ${params.pairingRecovery.requestId}`)}`,
              ),
            ]
          : []),
        theme.muted(`Fallback: ${formatCliCommand("openclaw devices approve --latest")}`),
        theme.muted(`Inspect: ${formatCliCommand("openclaw devices list")}`),
      ]
    : [];
  const modelSelectionLines = buildStatusModelSelectionLines(params.summary.sessions.recent);
  const channelsColumns = statusChannelsTableColumns;
  const channelsRows = buildStatusChannelsTableRows({
    rows: params.channels.rows,
    channelIssues: params.channelIssues,
    ok: theme.success,
    warn: theme.warn,
    muted: theme.muted,
    accentDim: theme.accentDim,
    formatIssueMessage: (message) => shortenText(message, 84),
  });
  const sessionsRows = params.summary.sessions.recent.map((sess) => ({
    Key: shortenText(sess.key, 32),
    Kind: sess.kind,
    Age: sess.updatedAt && sess.age != null ? formatTimeAgo(sess.age) : "no activity",
    Model: sess.model ?? "unknown",
    Runtime: sess.runtime ?? "unknown",
    Tokens: formatTokensCompact(sess),
    ...(params.opts.verbose ? { Cache: formatPromptCacheCompact(sess) || theme.muted("—") } : {}),
  }));
  const systemEventsRows =
    params.summary.queuedSystemEvents.length === 0
      ? undefined
      : params.summary.queuedSystemEvents.slice(0, 5).map((event) => ({ Event: event }));
  const systemEventsTrailer =
    params.summary.queuedSystemEvents.length > 5
      ? theme.muted(`… +${params.summary.queuedSystemEvents.length - 5} more`)
      : null;
  const healthColumns = params.health ? statusHealthColumns : undefined;
  const healthRows = params.health
    ? buildStatusHealthRows({
        health: params.health,
        sqliteWal: params.summary.sqliteWal,
      })
    : undefined;
  const usageLines = params.usageLines;
  const updateHint = formatUpdateAvailableHint(params.surface.update);
  const footerLines = [
    "FAQ: https://docs.openclaw.ai/faq",
    "Troubleshooting: https://docs.openclaw.ai/troubleshooting",
    ...(updateHint ? ["", theme.warn(updateHint)] : []),
    "Next steps:",
    `  Need to share?      ${formatCliCommand("openclaw status --all")}`,
    `  Need to debug live? ${formatCliCommand("openclaw logs --follow")}`,
    params.surface.nodeOnlyGateway
      ? `  Need node service?  ${formatCliCommand("openclaw node status")}`
      : params.surface.gatewayProbe?.startupPhase
        ? `  Retry after startup: ${formatCliCommand("openclaw status --deep")}`
        : params.surface.gatewayReachable
          ? `  Need to test channels? ${formatCliCommand("openclaw status --deep")}`
          : `  Fix reachability first: ${formatCliCommand("openclaw gateway probe")}`,
  ];

  const lines: string[] = [];
  lines.push(theme.heading("OpenClaw status"));

  const report = {
    lines,
    heading: theme.heading,
    width,
  };
  appendStatusReportTable(report, "Overview", [...statusOverviewTableColumns], overviewRows);
  if (pluginCompatibilityLines.length > 0) {
    appendStatusReportLines(report, "Plugin compatibility", pluginCompatibilityLines);
  }
  if (pairingRecoveryLines.length > 0) {
    lines.push("", ...pairingRecoveryLines);
  }
  if (modelSelectionLines.length > 0) {
    appendStatusReportLines(report, "Model selection", modelSelectionLines);
  }
  appendStatusReportLines(report, "Security audit", securityAuditLines);
  for (const [title, columns, rows, emptyMessage] of [
    ["Channels", channelsColumns, channelsRows, "No channels configured"],
    ["Sessions", sessionsColumns, sessionsRows, "No sessions"],
  ] as const) {
    if (rows.length === 0) {
      appendStatusReportLines(report, title, [theme.muted(emptyMessage)]);
    } else {
      appendStatusReportTable(report, title, [...columns], rows);
    }
  }
  if (systemEventsRows?.length) {
    appendStatusReportTable(
      report,
      "System events",
      [{ key: "Event", header: "Event", flex: true, minWidth: 24 }],
      systemEventsRows,
      systemEventsTrailer,
    );
  }
  if (healthRows?.length) {
    appendStatusReportTable(report, "Health", [...(healthColumns ?? [])], healthRows);
  }
  if (usageLines?.length) {
    appendStatusReportLines(report, "Usage", usageLines);
  }
  lines.push("", ...footerLines);
  return lines;
}
