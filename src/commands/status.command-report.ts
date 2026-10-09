import type { TableColumn } from "../../packages/terminal-core/src/table.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { statusOverviewTableColumns } from "./status-all/report-tables.js";
import { appendStatusReportLines, appendStatusReportTable } from "./status-all/text-report.js";

export async function buildStatusCommandReportLines(params: {
  width: number;
  overviewRows: Array<{ Item: string; Value: string }>;
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
  lines.push(theme.heading("OpenClaw status"));

  const report = {
    lines,
    heading: theme.heading,
    width: params.width,
  };
  // Prepare empty-state styling before rendering any table.
  const channelsMessage =
    params.channelsRows.length === 0 ? theme.muted("No channels configured") : undefined;
  const sessionsMessage = params.sessionsRows.length === 0 ? theme.muted("No sessions") : undefined;

  appendStatusReportTable(report, "Overview", [...statusOverviewTableColumns], params.overviewRows);
  if (params.pluginCompatibilityLines.length > 0) {
    appendStatusReportLines(report, "Plugin compatibility", params.pluginCompatibilityLines);
  }
  if (params.pairingRecoveryLines.length > 0) {
    lines.push("", ...params.pairingRecoveryLines);
  }
  if (params.modelSelectionLines.length > 0) {
    appendStatusReportLines(report, "Model selection", params.modelSelectionLines);
  }
  appendStatusReportLines(report, "Security audit", params.securityAuditLines);
  if (channelsMessage !== undefined) {
    appendStatusReportLines(report, "Channels", [channelsMessage]);
  } else {
    appendStatusReportTable(report, "Channels", [...params.channelsColumns], params.channelsRows);
  }
  if (sessionsMessage !== undefined) {
    appendStatusReportLines(report, "Sessions", [sessionsMessage]);
  } else {
    appendStatusReportTable(report, "Sessions", [...params.sessionsColumns], params.sessionsRows);
  }
  if (params.systemEventsRows?.length) {
    appendStatusReportTable(
      report,
      "System events",
      [{ key: "Event", header: "Event", flex: true, minWidth: 24 }],
      params.systemEventsRows,
      params.systemEventsTrailer,
    );
  }
  if (params.healthRows?.length) {
    appendStatusReportTable(report, "Health", [...(params.healthColumns ?? [])], params.healthRows);
  }
  if (params.usageLines?.length) {
    appendStatusReportLines(report, "Usage", params.usageLines);
  }
  lines.push("", ...params.footerLines);
  return lines;
}
