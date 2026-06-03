import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

/** Resolve an account config entry by exact key first, then lowercase-normalized key match. */
export function resolveAccountEntry<T>(
  accounts: Record<string, T> | undefined,
  accountId: string,
): T | undefined {
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  if (Object.hasOwn(accounts, accountId)) {
    // Exact own-key lookup takes precedence so an intentionally cased account id
    // is not shadowed by another key that normalizes to the same value.
    return accounts[accountId];
  }
  const normalized = normalizeLowercaseStringOrEmpty(accountId);
  const matchKey = Object.keys(accounts).find(
    (key) => normalizeLowercaseStringOrEmpty(key) === normalized,
  );
  return matchKey ? accounts[matchKey] : undefined;
}

/** Resolve account entries with a plugin-provided normalizer for channel-specific aliases. */
export function resolveNormalizedAccountEntry<T>(
  accounts: Record<string, T> | undefined,
  accountId: string,
  normalizeAccountId: (accountId: string) => string,
): T | undefined {
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }
  if (Object.hasOwn(accounts, accountId)) {
    // Keep direct own-key lookup ahead of normalized scans for duplicate-normalized maps.
    return accounts[accountId];
  }
  const normalized = normalizeAccountId(accountId);
  const matchKey = Object.keys(accounts).find((key) => normalizeAccountId(key) === normalized);
  return matchKey ? accounts[matchKey] : undefined;
}
