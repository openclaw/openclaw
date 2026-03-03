import { normalizeChannelId } from "../channels/plugins/index.js";
import { resolveAccountEntry } from "../routing/account-lookup.js";
import { normalizeAccountId } from "../routing/session-key.js";
const isStringArray = (value) => Array.isArray(value) && value.every((entry) => typeof entry === "string");
function normalizeCapabilities(capabilities) {
    // Handle object-format capabilities (e.g., { inlineButtons: "dm" }) gracefully.
    // Channel-specific handlers (like resolveTelegramInlineButtonsScope) process these separately.
    if (!isStringArray(capabilities)) {
        return undefined;
    }
    const normalized = capabilities.map((entry) => entry.trim()).filter(Boolean);
    return normalized.length > 0 ? normalized : undefined;
}
function resolveAccountCapabilities(params) {
    const cfg = params.cfg;
    if (!cfg) {
        return undefined;
    }
    const normalizedAccountId = normalizeAccountId(params.accountId);
    const accounts = cfg.accounts;
    if (accounts && typeof accounts === "object") {
        const match = resolveAccountEntry(accounts, normalizedAccountId);
        if (match) {
            return normalizeCapabilities(match.capabilities) ?? normalizeCapabilities(cfg.capabilities);
        }
    }
    return normalizeCapabilities(cfg.capabilities);
}
export function resolveChannelCapabilities(params) {
    const cfg = params.cfg;
    const channel = normalizeChannelId(params.channel);
    if (!cfg || !channel) {
        return undefined;
    }
    const channelsConfig = cfg.channels;
    const channelConfig = (channelsConfig?.[channel] ?? cfg[channel]);
    return resolveAccountCapabilities({
        cfg: channelConfig,
        accountId: params.accountId,
    });
}
