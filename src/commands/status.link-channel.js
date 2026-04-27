import { listReadOnlyChannelPluginsForConfig } from "../channels/plugins/read-only.js";
import { resolveDefaultChannelAccountContext } from "./channel-account-context.js";
export async function resolveLinkChannelContext(cfg, options = {}) {
    const sourceConfig = options.sourceConfig ?? cfg;
    for (const plugin of listReadOnlyChannelPluginsForConfig(cfg, {
        activationSourceConfig: sourceConfig,
    })) {
        const { defaultAccountId, account, enabled, configured } = await resolveDefaultChannelAccountContext(plugin, cfg, {
            mode: "read_only",
            commandName: "status",
        });
        const snapshot = plugin.config.describeAccount
            ? plugin.config.describeAccount(account, cfg)
            : {
                accountId: defaultAccountId,
                enabled,
                configured,
            };
        const summary = plugin.status?.buildChannelSummary
            ? await plugin.status.buildChannelSummary({
                account,
                cfg,
                defaultAccountId,
                snapshot,
            })
            : undefined;
        const summaryRecord = summary;
        const linked = summaryRecord && typeof summaryRecord.linked === "boolean" ? summaryRecord.linked : null;
        if (linked === null) {
            continue;
        }
        const authAgeMs = summaryRecord && typeof summaryRecord.authAgeMs === "number" ? summaryRecord.authAgeMs : null;
        return { linked, authAgeMs, account, accountId: defaultAccountId, plugin };
    }
    return null;
}
