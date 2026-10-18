import type { ConnectPairingRequiredReason } from "../../packages/gateway-protocol/src/connect-error-details.js";
import type { TableColumn } from "../../packages/terminal-core/src/table.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { resolveOsSummary } from "../infra/os-summary.js";
import type { SecurityAuditReport } from "../security/audit.js";
import { readBackupRunFreshness } from "../state/backup-run-records.js";
import {
  buildStatusChannelsTableRows,
  statusChannelsTableColumns,
} from "./status-all/channels-table.js";
import { statusOverviewTableColumns } from "./status-all/report-tables.js";
import { appendStatusReportLines, appendStatusReportTable } from "./status-all/text-report.js";
import { resolveStatusDatabaseEngines } from "./status-database-engines.js";
import { buildStatusCommandOverviewRows } from "./status-overview-rows.ts";
import {
  buildStatusFooterLines,
  buildStatusHealthRows,
  buildStatusModelSelectionLines,
  buildStatusPairingRecoveryLines,
  buildStatusPluginCompatibilityLines,
  buildStatusSecurityAuditLines,
  buildStatusSessionsRows,
  buildStatusSystemEventsRows,
  buildStatusSystemEventsTrailer,
  statusHealthColumns,
} from "./status.command-sections.js";
import { formatUpdateAvailableHint } from "./status.update.js";
import { shortenText } from "./text-format.js";

export async function buildStatusCommandReportLines(
  params: Omit<
    Parameters<typeof buildStatusCommandOverviewRows>[0],
    "backupFreshness" | "osLabel"
  > & {
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
  const overviewRows = buildStatusCommandOverviewRows({
    ...params,
    surface: {
      ...params.surface,
      databaseEngines: await resolveStatusDatabaseEngines(
        params.surface.cfg,
        params.summary.databaseStores,
      ),
    },
    backupFreshness: await readBackupRunFreshness(params.env),
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
  const pluginCompatibilityLines = buildStatusPluginCompatibilityLines({
    notices: params.pluginCompatibility,
  });
  const pairingRecoveryLines = buildStatusPairingRecoveryLines({
    pairingRecovery: params.pairingRecovery,
  });
  const modelSelectionLines = buildStatusModelSelectionLines({
    recent: params.summary.sessions.recent,
  });
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
  const sessionsRows = buildStatusSessionsRows({
    recent: params.summary.sessions.recent,
    verbose: params.opts.verbose,
  });
  const systemEventsRows = buildStatusSystemEventsRows({
    queuedSystemEvents: params.summary.queuedSystemEvents,
  });
  const systemEventsTrailer = buildStatusSystemEventsTrailer({
    queuedSystemEvents: params.summary.queuedSystemEvents,
  });
  const healthColumns = params.health ? statusHealthColumns : undefined;
  const healthRows = params.health
    ? buildStatusHealthRows({
        health: params.health,
        sqliteWal: params.summary.sqliteWal,
      })
    : undefined;
  const usageLines = params.usageLines;
  const footerLines = buildStatusFooterLines({
    updateHint: formatUpdateAvailableHint(params.surface.update),
    nodeOnlyGateway: params.surface.nodeOnlyGateway,
    gatewayReachable: params.surface.gatewayReachable,
    gatewayStartupPhase: params.surface.gatewayProbe?.startupPhase,
  });

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
