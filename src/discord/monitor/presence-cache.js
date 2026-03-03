/**
 * In-memory cache of Discord user presence data.
 * Populated by PRESENCE_UPDATE gateway events when the GuildPresences intent is enabled.
 * Per-account maps are capped to prevent unbounded growth (#4948).
 */
const MAX_PRESENCE_PER_ACCOUNT = 5000;
const presenceCache = new Map();
function resolveAccountKey(accountId) {
    return accountId ?? "default";
}
/** Update cached presence for a user. */
export function setPresence(accountId, userId, data) {
    const accountKey = resolveAccountKey(accountId);
    let accountCache = presenceCache.get(accountKey);
    if (!accountCache) {
        accountCache = new Map();
        presenceCache.set(accountKey, accountCache);
    }
    accountCache.set(userId, data);
    // Evict oldest entries if cache exceeds limit
    if (accountCache.size > MAX_PRESENCE_PER_ACCOUNT) {
        const oldest = accountCache.keys().next().value;
        if (oldest !== undefined) {
            accountCache.delete(oldest);
        }
    }
}
/** Get cached presence for a user. Returns undefined if not cached. */
export function getPresence(accountId, userId) {
    return presenceCache.get(resolveAccountKey(accountId))?.get(userId);
}
/** Clear cached presence data. */
export function clearPresences(accountId) {
    if (accountId) {
        presenceCache.delete(resolveAccountKey(accountId));
        return;
    }
    presenceCache.clear();
}
/** Get the number of cached presence entries. */
export function presenceCacheSize() {
    let total = 0;
    for (const accountCache of presenceCache.values()) {
        total += accountCache.size;
    }
    return total;
}
