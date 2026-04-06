import type { ProgressReporter } from "../../cli/progress.js";
import { getTerminalTableWidth, renderTable } from "../../terminal/table.js";
import { isRich, theme } from "../../terminal/theme.js";
import { buildStatusChannelsTableRows, statusChannelsTableColumns } from "./channels-table.js";
import { appendStatusAllDiagnosis } from "./diagnosis.js";
import { formatTimeAgo } from "./format.js";
import {
  appendStatusLinesSection,
  appendStatusSectionHeading,
  appendStatusTableSection,
} from "./text-report.js";

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

  const overview = renderTable({
    width: tableWidth,
    columns: [
      { key: "Item", header: "Item", minWidth: 10 },
      { key: "Value", header: "Value", flex: true, minWidth: 24 },
    ],
    rows: params.overviewRows,
  });

  const channelsTable = renderTable({
    width: tableWidth,
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
  });

  const agentRows = params.agentStatus.agents.map((a) => ({
    Agent: a.name?.trim() ? `${a.id} (${a.name.trim()})` : a.id,
    BootstrapFile:
      a.bootstrapPending === true
        ? warn("PRESENT")
        : a.bootstrapPending === false
          ? ok("ABSENT")
          : "unknown",
    Sessions: String(a.sessionsCount),
    Active: a.lastActiveAgeMs != null ? formatTimeAgo(a.lastActiveAgeMs) : "unknown",
    Store: a.sessionsPath,
  }));

  const agentsTable = renderTable({
    width: tableWidth,
    columns: [
      { key: "Agent", header: "Agent", minWidth: 12 },
      { key: "BootstrapFile", header: "Bootstrap file", minWidth: 14 },
      { key: "Sessions", header: "Sessions", align: "right", minWidth: 8 },
      { key: "Active", header: "Active", minWidth: 10 },
      { key: "Store", header: "Store", flex: true, minWidth: 34 },
    ],
    rows: agentRows,
  });

  const lines: string[] = [];
  lines.push(heading("OpenClaw status --all"));
  appendStatusLinesSection({
    lines,
    heading,
    title: "Overview",
    body: [overview.trimEnd()],
  });
  appendStatusLinesSection({
    lines,
    heading,
    title: "Channels",
    body: [channelsTable.trimEnd()],
  });
  for (const detail of params.channels.details) {
    appendStatusTableSection({
      lines,
      heading,
      title: detail.title,
      width: tableWidth,
      renderTable,
      columns: detail.columns.map((c) => ({
        key: c,
        header: c,
        flex: c === "Notes",
        minWidth: c === "Notes" ? 28 : 10,
      })),
      rows: detail.rows.map((r) => ({
        ...r,
        ...(r.Status === "OK"
          ? { Status: ok("OK") }
          : r.Status === "WARN"
            ? { Status: warn("WARN") }
            : {}),
      })),
    });
  }
  appendStatusLinesSection({
    lines,
    heading,
    title: "Agents",
    body: [agentsTable.trimEnd()],
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
