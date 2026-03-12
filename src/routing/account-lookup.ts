export function resolveAccountEntry<T>(
  accounts: Record<string, T> | undefined,
  accountId: string,
): T | undefined {
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
