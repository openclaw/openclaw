import type { TableColumn } from "../terminal/table.js";
import { statusOverviewTableColumns } from "./status-all/report-tables.js";
import { appendStatusReportSections } from "./status-all/text-report.js";

export async function buildStatusCommandReportLines(params: {
  heading: (text: string) => string;
  muted: (text: string) => string;
  renderTable: (input: {
    width: number;
    columns: TableColumn[];
    rows: Array<Record<string, string>>;
  }) => string;
  width: number;
  overviewRows: Array<{ Item: string; Value: string }>;
  showTaskMaintenanceHint: boolean;
  taskMaintenanceHint: string;
  pluginCompatibilityLines: string[];
  pairingRecoveryLines: string[];
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

  appendStatusReportSections({
    lines,
    heading: params.heading,
    sections: [
      {
        kind: "table",
        title: "Overview",
        width: params.width,
        renderTable: params.renderTable,
        columns: statusOverviewTableColumns,
        rows: params.overviewRows,
      },
      {
        kind: "raw",
        body: params.showTaskMaintenanceHint ? ["", params.muted(params.taskMaintenanceHint)] : [],
        skipIfEmpty: true,
      },
      {
        kind: "lines",
        title: "Plugin compatibility",
        body: params.pluginCompatibilityLines,
        skipIfEmpty: true,
      },
      {
        kind: "raw",
        body: params.pairingRecoveryLines.length > 0 ? ["", ...params.pairingRecoveryLines] : [],
        skipIfEmpty: true,
      },
      {
        kind: "lines",
        title: "Security audit",
        body: params.securityAuditLines,
      },
      {
        kind: "table",
        title: "Channels",
        width: params.width,
        renderTable: params.renderTable,
        columns: params.channelsColumns,
        rows: params.channelsRows,
      },
      {
        kind: "table",
        title: "Sessions",
        width: params.width,
        renderTable: params.renderTable,
        columns: params.sessionsColumns,
        rows: params.sessionsRows,
      },
      {
        kind: "table",
        title: "System events",
        width: params.width,
        renderTable: params.renderTable,
        columns: [{ key: "Event", header: "Event", flex: true, minWidth: 24 }],
        rows: params.systemEventsRows ?? [],
        trailer: params.systemEventsTrailer,
        skipIfEmpty: true,
      },
      {
        kind: "table",
        title: "Health",
        width: params.width,
        renderTable: params.renderTable,
        columns: params.healthColumns ?? [],
        rows: params.healthRows ?? [],
        skipIfEmpty: true,
      },
      {
        kind: "lines",
        title: "Usage",
        body: params.usageLines ?? [],
        skipIfEmpty: true,
      },
      {
        kind: "raw",
        body: ["", ...params.footerLines],
      },
    ],
  });
  return lines;
}
