import { groupChannelIssuesByChannel } from "./channel-issues.js";
export const statusChannelsTableColumns = [
    { key: "Channel", header: "Channel", minWidth: 10 },
    { key: "Enabled", header: "Enabled", minWidth: 7 },
    { key: "State", header: "State", minWidth: 8 },
    { key: "Detail", header: "Detail", flex: true, minWidth: 24 },
];
export function buildStatusChannelsTableRows(params) {
    const channelIssuesByChannel = groupChannelIssuesByChannel(params.channelIssues);
    const formatIssueMessage = params.formatIssueMessage ?? ((message) => message);
    return params.rows.map((row) => {
        const issues = channelIssuesByChannel.get(row.id) ?? [];
        const effectiveState = row.state === "off" ? "off" : issues.length > 0 ? "warn" : row.state;
        const issueSuffix = issues.length > 0
            ? ` · ${params.warn(`gateway: ${formatIssueMessage(issues[0]?.message ?? "issue")}`)}`
            : "";
        return {
            Channel: row.label,
            Enabled: row.enabled ? params.ok("ON") : params.muted("OFF"),
            State: effectiveState === "ok"
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
