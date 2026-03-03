export function resolveAccountWithDefaultFallback(params) {
    const hasExplicitAccountId = Boolean(params.accountId?.trim());
    const normalizedAccountId = params.normalizeAccountId(params.accountId);
    const primary = params.resolvePrimary(normalizedAccountId);
    if (hasExplicitAccountId || params.hasCredential(primary)) {
        return primary;
    }
    const fallbackId = params.resolveDefaultAccountId();
    if (fallbackId === normalizedAccountId) {
        return primary;
    }
    const fallback = params.resolvePrimary(fallbackId);
    if (!params.hasCredential(fallback)) {
        return primary;
    }
    return fallback;
}
export function listConfiguredAccountIds(params) {
    if (!params.accounts) {
        return [];
    }
    const ids = new Set();
    for (const key of Object.keys(params.accounts)) {
        if (!key) {
            continue;
        }
        ids.add(params.normalizeAccountId(key));
    }
    return [...ids];
}
