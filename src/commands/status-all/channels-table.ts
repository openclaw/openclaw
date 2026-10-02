import { indexFirstByKey } from "../../shared/dedupe-by-key.js";

type ChannelTableRowInput = {
  id: string;
  label: string;
  enabled: boolean;
  state: "ok" | "warn" | "off" | "setup";
  detail: string;
};

type ChannelIssueLike = {
  channel: string;
  message: string;
};

export const statusChannelsTableColumns = [
  { key: "Channel", header: "Channel", minWidth: 10 },
  { key: "Enabled", header: "Enabled", minWidth: 7 },
  { key: "State", header: "State", minWidth: 8 },
  { key: "Detail", header: "Detail", flex: true, minWidth: 24 },
] as const;

export function buildStatusChannelsTableRows(params: {
  rows: readonly ChannelTableRowInput[];
  channelIssues: readonly ChannelIssueLike[];
  ok: (text: string) => string;
  warn: (text: string) => string;
  muted: (text: string) => string;
  accentDim: (text: string) => string;
  formatIssueMessage?: (message: string) => string;
}) {
  const firstIssueByChannel = indexFirstByKey(params.channelIssues, (issue) => issue.channel);
  const formatIssueMessage = params.formatIssueMessage ?? ((message: string) => message);
  return params.rows.map((row) => {
    const issue = firstIssueByChannel.get(row.id);
    // A disabled channel stays disabled even if the gateway still reports stale issues for it.
    const effectiveState = row.state === "off" ? "off" : issue ? "warn" : row.state;
    const issueSuffix = issue
      ? ` · ${params.warn(`gateway: ${formatIssueMessage(issue.message ?? "issue")}`)}`
      : "";
    return {
      Channel: row.label,
      Enabled: row.enabled ? params.ok("ON") : params.muted("OFF"),
      State:
        effectiveState === "ok"
          ? params.ok("OK")
          : effectiveState === "warn"
            ? params.warn("WARN")
            : effectiveState === "off"
              ? params.muted("OFF")
              : params.accentDim("SETUP"),
      Detail: `${row.detail}${issueSuffix}`,
    };
  });
}
