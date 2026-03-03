import { normalizeAccountId } from "../routing/session-key.js";
function resolveAccountChannels(cfg, accountId) {
    if (!accountId) {
        return {};
    }
    const normalized = normalizeAccountId(accountId);
    const accounts = cfg.channels?.slack?.accounts;
    if (!accounts || typeof accounts !== "object") {
        return {};
    }
    const exact = accounts[normalized];
    if (exact?.channels) {
        return { channels: exact.channels };
    }
    const matchKey = Object.keys(accounts).find((key) => key.toLowerCase() === normalized.toLowerCase());
    return { channels: matchKey ? accounts[matchKey]?.channels : undefined };
}
export function migrateSlackChannelsInPlace(channels, oldChannelId, newChannelId) {
    if (!channels) {
        return { migrated: false, skippedExisting: false };
    }
    if (oldChannelId === newChannelId) {
        return { migrated: false, skippedExisting: false };
    }
    if (!Object.hasOwn(channels, oldChannelId)) {
        return { migrated: false, skippedExisting: false };
    }
    if (Object.hasOwn(channels, newChannelId)) {
        return { migrated: false, skippedExisting: true };
    }
    channels[newChannelId] = channels[oldChannelId];
    delete channels[oldChannelId];
    return { migrated: true, skippedExisting: false };
}
export function migrateSlackChannelConfig(params) {
    const scopes = [];
    let migrated = false;
    let skippedExisting = false;
    const accountChannels = resolveAccountChannels(params.cfg, params.accountId).channels;
    if (accountChannels) {
        const result = migrateSlackChannelsInPlace(accountChannels, params.oldChannelId, params.newChannelId);
        if (result.migrated) {
            migrated = true;
            scopes.push("account");
        }
        if (result.skippedExisting) {
            skippedExisting = true;
        }
    }
    const globalChannels = params.cfg.channels?.slack?.channels;
    if (globalChannels) {
        const result = migrateSlackChannelsInPlace(globalChannels, params.oldChannelId, params.newChannelId);
        if (result.migrated) {
            migrated = true;
            scopes.push("global");
        }
        if (result.skippedExisting) {
            skippedExisting = true;
        }
    }
    return { migrated, skippedExisting, scopes };
}
