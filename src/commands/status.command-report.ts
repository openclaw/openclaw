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
  for (const [title, columns, rows, emptyMessage] of [
    ["Channels", params.channelsColumns, params.channelsRows, "No channels configured"],
    ["Sessions", params.sessionsColumns, params.sessionsRows, "No sessions"],
  ] as const) {
    if (rows.length === 0) {
      appendStatusReportLines(report, title, [theme.muted(emptyMessage)]);
    } else {
      appendStatusReportTable(report, title, [...columns], rows);
    }
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
