import { buildChannelAccountSnapshot, formatChannelAllowFrom, } from "../channels/account-summary.js";
import { listChannelPlugins } from "../channels/plugins/index.js";
import { loadConfig } from "../config/config.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import { theme } from "../terminal/theme.js";
import { formatTimeAgo } from "./format-time/format-relative.ts";
const DEFAULT_OPTIONS = {
    colorize: false,
    includeAllowFrom: false,
};
const formatAccountLabel = (params) => {
    const base = params.accountId || DEFAULT_ACCOUNT_ID;
    if (params.name?.trim()) {
        return `${base} (${params.name.trim()})`;
    }
    return base;
};
const accountLine = (label, details) => `  - ${label}${details.length ? ` (${details.join(", ")})` : ""}`;
const resolveAccountEnabled = (plugin, account, cfg) => {
    if (plugin.config.isEnabled) {
        return plugin.config.isEnabled(account, cfg);
    }
    if (!account || typeof account !== "object") {
        return true;
    }
    const enabled = account.enabled;
    return enabled !== false;
};
const resolveAccountConfigured = async (plugin, account, cfg) => {
    if (plugin.config.isConfigured) {
        return await plugin.config.isConfigured(account, cfg);
    }
    return true;
};
const buildAccountDetails = (params) => {
    const details = [];
    const snapshot = params.entry.snapshot;
    if (snapshot.enabled === false) {
        details.push("disabled");
    }
    if (snapshot.dmPolicy) {
        details.push(`dm:${snapshot.dmPolicy}`);
    }
    if (snapshot.tokenSource && snapshot.tokenSource !== "none") {
        details.push(`token:${snapshot.tokenSource}`);
    }
    if (snapshot.botTokenSource && snapshot.botTokenSource !== "none") {
        details.push(`bot:${snapshot.botTokenSource}`);
    }
    if (snapshot.appTokenSource && snapshot.appTokenSource !== "none") {
        details.push(`app:${snapshot.appTokenSource}`);
    }
    if (snapshot.baseUrl) {
        details.push(snapshot.baseUrl);
    }
    if (snapshot.port != null) {
        details.push(`port:${snapshot.port}`);
    }
    if (snapshot.cliPath) {
        details.push(`cli:${snapshot.cliPath}`);
    }
    if (snapshot.dbPath) {
        details.push(`db:${snapshot.dbPath}`);
    }
    if (params.includeAllowFrom && snapshot.allowFrom?.length) {
        const formatted = formatChannelAllowFrom({
            plugin: params.plugin,
            cfg: params.cfg,
            accountId: snapshot.accountId,
            allowFrom: snapshot.allowFrom,
        }).slice(0, 2);
        if (formatted.length > 0) {
            details.push(`allow:${formatted.join(",")}`);
        }
    }
    return details;
};
export async function buildChannelSummary(cfg, options) {
    const effective = cfg ?? loadConfig();
    const lines = [];
    const resolved = { ...DEFAULT_OPTIONS, ...options };
    const tint = (value, color) => resolved.colorize && color ? color(value) : value;
    for (const plugin of listChannelPlugins()) {
        const accountIds = plugin.config.listAccountIds(effective);
        const defaultAccountId = plugin.config.defaultAccountId?.(effective) ?? accountIds[0] ?? DEFAULT_ACCOUNT_ID;
        const resolvedAccountIds = accountIds.length > 0 ? accountIds : [defaultAccountId];
        const entries = [];
        for (const accountId of resolvedAccountIds) {
            const account = plugin.config.resolveAccount(effective, accountId);
            const enabled = resolveAccountEnabled(plugin, account, effective);
            const configured = await resolveAccountConfigured(plugin, account, effective);
            const snapshot = buildChannelAccountSnapshot({
                plugin,
                account,
                cfg: effective,
                accountId,
                enabled,
                configured,
            });
            entries.push({ accountId, account, enabled, configured, snapshot });
        }
        const configuredEntries = entries.filter((entry) => entry.configured);
        const anyEnabled = entries.some((entry) => entry.enabled);
        const fallbackEntry = entries.find((entry) => entry.accountId === defaultAccountId) ?? entries[0];
        const summary = plugin.status?.buildChannelSummary
            ? await plugin.status.buildChannelSummary({
                account: fallbackEntry?.account ?? {},
                cfg: effective,
                defaultAccountId,
                snapshot: fallbackEntry?.snapshot ?? { accountId: defaultAccountId },
            })
            : undefined;
        const summaryRecord = summary;
        const linked = summaryRecord && typeof summaryRecord.linked === "boolean" ? summaryRecord.linked : null;
        const configured = summaryRecord && typeof summaryRecord.configured === "boolean"
            ? summaryRecord.configured
            : configuredEntries.length > 0;
        const status = !anyEnabled
            ? "disabled"
            : linked !== null
                ? linked
                    ? "linked"
                    : "not linked"
                : configured
                    ? "configured"
                    : "not configured";
        const statusColor = status === "linked" || status === "configured"
            ? theme.success
            : status === "not linked"
                ? theme.error
                : theme.muted;
        const baseLabel = plugin.meta.label ?? plugin.id;
        let line = `${baseLabel}: ${status}`;
        const authAgeMs = summaryRecord && typeof summaryRecord.authAgeMs === "number" ? summaryRecord.authAgeMs : null;
        const self = summaryRecord?.self;
        if (self?.e164) {
            line += ` ${self.e164}`;
        }
        if (authAgeMs != null && authAgeMs >= 0) {
            line += ` auth ${formatTimeAgo(authAgeMs)}`;
        }
        lines.push(tint(line, statusColor));
        if (configuredEntries.length > 0) {
            for (const entry of configuredEntries) {
                const details = buildAccountDetails({
                    entry,
                    plugin,
                    cfg: effective,
                    includeAllowFrom: resolved.includeAllowFrom,
                });
                lines.push(accountLine(formatAccountLabel({
                    accountId: entry.accountId,
                    name: entry.snapshot.name,
                }), details));
            }
        }
    }
    return lines;
}
