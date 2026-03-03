import { normalizeAccountId } from "../routing/session-key.js";
function resolveAccountGroups(cfg, accountId) {
    if (!accountId) {
        return {};
    }
    const normalized = normalizeAccountId(accountId);
    const accounts = cfg.channels?.telegram?.accounts;
    if (!accounts || typeof accounts !== "object") {
        return {};
    }
    const exact = accounts[normalized];
    if (exact?.groups) {
        return { groups: exact.groups };
    }
    const matchKey = Object.keys(accounts).find((key) => key.toLowerCase() === normalized.toLowerCase());
    return { groups: matchKey ? accounts[matchKey]?.groups : undefined };
}
export function migrateTelegramGroupsInPlace(groups, oldChatId, newChatId) {
    if (!groups) {
        return { migrated: false, skippedExisting: false };
    }
    if (oldChatId === newChatId) {
        return { migrated: false, skippedExisting: false };
    }
    if (!Object.hasOwn(groups, oldChatId)) {
        return { migrated: false, skippedExisting: false };
    }
    if (Object.hasOwn(groups, newChatId)) {
        return { migrated: false, skippedExisting: true };
    }
    groups[newChatId] = groups[oldChatId];
    delete groups[oldChatId];
    return { migrated: true, skippedExisting: false };
}
export function migrateTelegramGroupConfig(params) {
    const scopes = [];
    let migrated = false;
    let skippedExisting = false;
    const migrationTargets = [
        { scope: "account", groups: resolveAccountGroups(params.cfg, params.accountId).groups },
        { scope: "global", groups: params.cfg.channels?.telegram?.groups },
    ];
    for (const target of migrationTargets) {
        const result = migrateTelegramGroupsInPlace(target.groups, params.oldChatId, params.newChatId);
        if (result.migrated) {
            migrated = true;
            scopes.push(target.scope);
        }
        if (result.skippedExisting) {
            skippedExisting = true;
        }
    }
    return { migrated, skippedExisting, scopes };
}
