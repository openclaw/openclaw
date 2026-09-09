// Renders the standard `openclaw status` report from prebuilt section data.
// Report data assembly stays separate so tests can validate rows without terminal formatting.

import type { RenderTableOptions, TableColumn } from "../../packages/terminal-core/src/table.js";
import { statusOverviewTableColumns } from "./status-all/report-tables.js";
import { appendStatusReportLines, appendStatusReportTable } from "./status-all/text-report.js";

/** Builds terminal lines for the standard status report. */
export async function buildStatusCommandReportLines(params: {
  heading: (text: string) => string;
  muted: (text: string) => string;
  renderTable: (input: RenderTableOptions) => string;
  width: number;
  overviewRows: Array<{ Item: string; Value: string }>;
  showTaskMaintenanceHint: boolean;
  taskMaintenanceHint: string;
  taskRegistryMigrationHint?: string | null;
  retainedLostTaskLine?: string | null;
  pluginCompatibilityLines: string[];
  pairingRecoveryLines: string[];
  modelSelectionLines: string[];
  securityAuditLines: string[];
  channelsColumns: readonly TableColumn[];
  channelsRows: Array<Record<string, string>>;
  sessionsColumns: readonly TableColumn[];
  sessionsRows: Array<Record<string, string>>;
  systemEventsRows?: Array<Record<string, string>>;
  systemEventsTrailer?: string | null;
  healthColumns?: readonly TableColumn[];
  healthRows?: Array<Record<string, string>>;
  usageLines?: string[];
  footerLines: string[];
}) {
  const lines: string[] = [];
  lines.push(params.heading("OpenClaw status"));

  const report = {
    lines,
    heading: params.heading,
    width: params.width,
    renderTable: params.renderTable,
  };
  // Prepare callbacks and column snapshots before rendering any table, as one report view.
  const overviewColumns = [...statusOverviewTableColumns];
  const overviewRows = params.overviewRows;
  const maintenanceLines =
    params.showTaskMaintenanceHint ||
    params.taskRegistryMigrationHint ||
    params.retainedLostTaskLine
      ? [
          "",
          ...(params.showTaskMaintenanceHint ? [params.muted(params.taskMaintenanceHint)] : []),
          ...(params.taskRegistryMigrationHint ? [params.taskRegistryMigrationHint] : []),
          ...(params.retainedLostTaskLine ? [params.retainedLostTaskLine] : []),
        ]
      : [];
  const pluginCompatibilityLines = params.pluginCompatibilityLines;
  const pairingRecoveryLines =
    params.pairingRecoveryLines.length > 0 ? ["", ...params.pairingRecoveryLines] : [];
  const modelSelectionLines = params.modelSelectionLines;
  const securityAuditLines = params.securityAuditLines;
  const channelsMessage =
    params.channelsRows.length === 0 ? params.muted("No channels configured") : undefined;
  const channelsColumns = channelsMessage === undefined ? [...params.channelsColumns] : [];
  const channelsRows = channelsMessage === undefined ? params.channelsRows : [];
  const sessionsMessage =
    params.sessionsRows.length === 0 ? params.muted("No sessions") : undefined;
  const sessionsColumns = sessionsMessage === undefined ? [...params.sessionsColumns] : [];
  const sessionsRows = sessionsMessage === undefined ? params.sessionsRows : [];
  const systemEventsColumns = [{ key: "Event", header: "Event", flex: true, minWidth: 24 }];
  const systemEventsRows = params.systemEventsRows ?? [];
  const systemEventsTrailer = params.systemEventsTrailer;
  const healthColumns = [...(params.healthColumns ?? [])];
  const healthRows = params.healthRows ?? [];
  const usageLines = params.usageLines ?? [];
  const footerLines = ["", ...params.footerLines];

  appendStatusReportTable(report, "Overview", overviewColumns, overviewRows);
  lines.push(...maintenanceLines);
  if (pluginCompatibilityLines.length > 0) {
    appendStatusReportLines(report, "Plugin compatibility", pluginCompatibilityLines);
  }
  lines.push(...pairingRecoveryLines);
  if (modelSelectionLines.length > 0) {
    appendStatusReportLines(report, "Model selection", modelSelectionLines);
  }
  appendStatusReportLines(report, "Security audit", securityAuditLines);
  if (channelsMessage !== undefined) {
    appendStatusReportLines(report, "Channels", [channelsMessage]);
  } else {
    appendStatusReportTable(report, "Channels", channelsColumns, channelsRows);
  }
  if (sessionsMessage !== undefined) {
    appendStatusReportLines(report, "Sessions", [sessionsMessage]);
  } else {
    appendStatusReportTable(report, "Sessions", sessionsColumns, sessionsRows);
  }
  if (systemEventsRows.length > 0) {
    appendStatusReportTable(
      report,
      "System events",
      systemEventsColumns,
      systemEventsRows,
      systemEventsTrailer,
    );
  }
  if (healthRows.length > 0) {
    appendStatusReportTable(report, "Health", healthColumns, healthRows);
  }
  if (usageLines.length > 0) {
    appendStatusReportLines(report, "Usage", usageLines);
  }
  lines.push(...footerLines);
  return lines;
}
