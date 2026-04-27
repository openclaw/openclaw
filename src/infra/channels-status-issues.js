import { listChannelPlugins } from "../channels/plugins/index.js";
export function collectChannelStatusIssues(payload) {
    const issues = [];
    const accountsByChannel = payload.channelAccounts;
    for (const plugin of listChannelPlugins()) {
        const collect = plugin.status?.collectStatusIssues;
        if (!collect) {
            continue;
        }
        const raw = accountsByChannel?.[plugin.id];
        if (!Array.isArray(raw)) {
            continue;
        }
        issues.push(...collect(raw));
    }
    return issues;
}
