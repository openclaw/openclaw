export function resolveAccountEntry(accounts, accountId) {
    if (!accounts || typeof accounts !== "object") {
        return undefined;
    }
    if (Object.hasOwn(accounts, accountId)) {
        return accounts[accountId];
    }
    const normalized = accountId.toLowerCase();
    const matchKey = Object.keys(accounts).find((key) => key.toLowerCase() === normalized);
    return matchKey ? accounts[matchKey] : undefined;
}
