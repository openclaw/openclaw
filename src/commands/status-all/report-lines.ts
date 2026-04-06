import type { ProgressReporter } from "../../cli/progress.js";
import { getTerminalTableWidth, renderTable } from "../../terminal/table.js";
import { isRich, theme } from "../../terminal/theme.js";
import { buildStatusChannelsTableRows, statusChannelsTableColumns } from "./channels-table.js";
import { appendStatusAllDiagnosis } from "./diagnosis.js";
import {
  buildStatusAgentTableRows,
  buildStatusChannelDetailSections,
  statusAgentsTableColumns,
  statusOverviewTableColumns,
} from "./report-tables.js";
import { appendStatusReportSections, appendStatusSectionHeading } from "./text-report.js";

type OverviewRow = { Item: string; Value: string };

type ChannelsTable = {
  rows: Array<{
    id: string;
    label: string;
    enabled: boolean;
    state: "ok" | "warn" | "off" | "setup";
    detail: string;
  }>;
  details: Array<{
    title: string;
    columns: string[];
    rows: Array<Record<string, string>>;
  }>;
};

type ChannelIssueLike = {
  channel: string;
  message: string;
};

type AgentStatusLike = {
  agents: Array<{
    id: string;
    name?: string | null;
    bootstrapPending?: boolean | null;
    sessionsCount: number;
    lastActiveAgeMs?: number | null;
    sessionsPath: string;
  }>;
};

export async function buildStatusAllReportLines(params: {
  progress: ProgressReporter;
  overviewRows: OverviewRow[];
  channels: ChannelsTable;
  channelIssues: ChannelIssueLike[];
  agentStatus: AgentStatusLike;
  connectionDetailsForReport: string;
  diagnosis: Omit<
    Parameters<typeof appendStatusAllDiagnosis>[0],
    "lines" | "progress" | "muted" | "ok" | "warn" | "fail" | "connectionDetailsForReport"
  >;
}) {
  const rich = isRich();
  const heading = (text: string) => (rich ? theme.heading(text) : text);
  const ok = (text: string) => (rich ? theme.success(text) : text);
  const warn = (text: string) => (rich ? theme.warn(text) : text);
  const fail = (text: string) => (rich ? theme.error(text) : text);
  const muted = (text: string) => (rich ? theme.muted(text) : text);

  const tableWidth = getTerminalTableWidth();

  const lines: string[] = [];
  lines.push(heading("OpenClaw status --all"));
  appendStatusReportSections({
    lines,
    heading,
    sections: [
      {
        kind: "table",
        title: "Overview",
        width: tableWidth,
        renderTable,
        columns: statusOverviewTableColumns,
        rows: params.overviewRows,
      },
      {
        kind: "table",
        title: "Channels",
        width: tableWidth,
        renderTable,
        columns: statusChannelsTableColumns.map((column) =>
          column.key === "Detail" ? { ...column, minWidth: 28 } : column,
        ),
        rows: buildStatusChannelsTableRows({
          rows: params.channels.rows,
          channelIssues: params.channelIssues,
          ok,
          warn,
          muted,
          accentDim: theme.accentDim,
          formatIssueMessage: (message) => String(message).slice(0, 90),
        }),
      },
      ...buildStatusChannelDetailSections({
        details: params.channels.details,
        width: tableWidth,
        renderTable,
        ok,
        warn,
      }),
      {
        kind: "table",
        title: "Agents",
        width: tableWidth,
        renderTable,
        columns: statusAgentsTableColumns,
        rows: buildStatusAgentTableRows({
          agentStatus: params.agentStatus,
          ok,
          warn,
        }),
      },
    ],
  });
  appendStatusSectionHeading({
    lines,
    heading,
    title: "Diagnosis (read-only)",
  });

  await appendStatusAllDiagnosis({
    lines,
    progress: params.progress,
    muted,
    ok,
    warn,
    fail,
    connectionDetailsForReport: params.connectionDetailsForReport,
    ...params.diagnosis,
  });

  return lines;
}
