import type { TableColumn } from "../terminal/table.js";
import { appendStatusLinesSection, appendStatusTableSection } from "./status-all/text-report.js";

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

  appendStatusTableSection({
    lines,
    heading: params.heading,
    title: "Overview",
    width: params.width,
    renderTable: params.renderTable,
    columns: [
      { key: "Item", header: "Item", minWidth: 12 },
      { key: "Value", header: "Value", flex: true, minWidth: 32 },
    ],
    rows: params.overviewRows,
  });

  if (params.showTaskMaintenanceHint) {
    lines.push("");
    lines.push(params.muted(params.taskMaintenanceHint));
  }

  if (params.pluginCompatibilityLines.length > 0) {
    appendStatusLinesSection({
      lines,
      heading: params.heading,
      title: "Plugin compatibility",
      body: params.pluginCompatibilityLines,
    });
  }

  if (params.pairingRecoveryLines.length > 0) {
    lines.push("");
    lines.push(...params.pairingRecoveryLines);
  }

  appendStatusLinesSection({
    lines,
    heading: params.heading,
    title: "Security audit",
    body: params.securityAuditLines,
  });

  appendStatusTableSection({
    lines,
    heading: params.heading,
    title: "Channels",
    width: params.width,
    renderTable: params.renderTable,
    columns: params.channelsColumns,
    rows: params.channelsRows,
  });

  appendStatusTableSection({
    lines,
    heading: params.heading,
    title: "Sessions",
    width: params.width,
    renderTable: params.renderTable,
    columns: params.sessionsColumns,
    rows: params.sessionsRows,
  });

  if (params.systemEventsRows && params.systemEventsRows.length > 0) {
    appendStatusTableSection({
      lines,
      heading: params.heading,
      title: "System events",
      width: params.width,
      renderTable: params.renderTable,
      columns: [{ key: "Event", header: "Event", flex: true, minWidth: 24 }],
      rows: params.systemEventsRows,
    });
    if (params.systemEventsTrailer) {
      lines.push(params.systemEventsTrailer);
    }
  }

  if (params.healthColumns && params.healthRows) {
    appendStatusTableSection({
      lines,
      heading: params.heading,
      title: "Health",
      width: params.width,
      renderTable: params.renderTable,
      columns: params.healthColumns,
      rows: params.healthRows,
    });
  }

  if (params.usageLines && params.usageLines.length > 0) {
    appendStatusLinesSection({
      lines,
      heading: params.heading,
      title: "Usage",
      body: params.usageLines,
    });
  }

  lines.push("");
  lines.push(...params.footerLines);
  return lines;
}
