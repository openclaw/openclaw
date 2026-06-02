/** List normalized configured account ids from a raw channel account record map. */
export function listConfiguredAccountIds(params: {
  /** Raw account map from a channel config section. */
  accounts: Record<string, unknown> | undefined;
  /** Channel-specific account id normalizer applied before dedupe. */
  normalizeAccountId: (accountId: string) => string;
}): string[] {
  if (!params.accounts) {
    return [];
  }
  const ids = new Set<string>();
  for (const key of Object.keys(params.accounts)) {
    if (!key) {
      continue;
    }
    // Normalize before dedupe so aliases/casing collapse to the account ids the channel uses.
    ids.add(params.normalizeAccountId(key));
  }
  return [...ids];
}
