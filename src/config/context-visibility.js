import { resolveAccountEntry } from "../routing/account-lookup.js";
import { normalizeAccountId } from "../routing/session-key.js";
export function resolveDefaultContextVisibility(cfg) {
    return cfg.channels?.defaults?.contextVisibility;
}
export function resolveChannelContextVisibilityMode(params) {
    if (params.configuredContextVisibility) {
        return params.configuredContextVisibility;
    }
    const channelConfig = params.cfg.channels?.[params.channel];
    const accountId = normalizeAccountId(params.accountId);
    const accountMode = resolveAccountEntry(channelConfig?.accounts, accountId)?.contextVisibility;
    return (accountMode ??
        channelConfig?.contextVisibility ??
        resolveDefaultContextVisibility(params.cfg) ??
        "all");
}
