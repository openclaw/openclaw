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

export async function buildStatusCommandReportData(
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
  return {
    width: params.tableWidth,
    overviewRows,
    pluginCompatibilityLines: buildStatusPluginCompatibilityLines({
      notices: params.pluginCompatibility,
    }),
    pairingRecoveryLines: buildStatusPairingRecoveryLines({
      pairingRecovery: params.pairingRecovery,
    }),
    modelSelectionLines: buildStatusModelSelectionLines({
      recent: params.summary.sessions.recent,
    }),
    securityAuditLines,
    channelsColumns: statusChannelsTableColumns,
    channelsRows: buildStatusChannelsTableRows({
      rows: params.channels.rows,
      channelIssues: params.channelIssues,
      ok: theme.success,
      warn: theme.warn,
      muted: theme.muted,
      accentDim: theme.accentDim,
      formatIssueMessage: (message) => shortenText(message, 84),
    }),
    sessionsColumns,
    sessionsRows: buildStatusSessionsRows({
      recent: params.summary.sessions.recent,
      verbose: params.opts.verbose,
    }),
    systemEventsRows: buildStatusSystemEventsRows({
      queuedSystemEvents: params.summary.queuedSystemEvents,
    }),
    systemEventsTrailer: buildStatusSystemEventsTrailer({
      queuedSystemEvents: params.summary.queuedSystemEvents,
    }),
    healthColumns: params.health ? statusHealthColumns : undefined,
    healthRows: params.health
      ? buildStatusHealthRows({
          health: params.health,
          sqliteWal: params.summary.sqliteWal,
        })
      : undefined,
    usageLines: params.usageLines,
    footerLines: buildStatusFooterLines({
      updateHint: formatUpdateAvailableHint(params.surface.update),
      nodeOnlyGateway: params.surface.nodeOnlyGateway,
      gatewayReachable: params.surface.gatewayReachable,
      gatewayStartupPhase: params.surface.gatewayProbe?.startupPhase,
    }),
  };
}
