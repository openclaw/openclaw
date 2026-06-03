export type { OpenClawConfig } from "../config/config.js";

export { createAccountActionGate } from "../channels/plugins/account-action-gate.js";
export {
  createAccountListHelpers,
  describeAccountSnapshot,
  hasConfiguredAccountValue,
  listCombinedAccountIds,
  mergeAccountConfig,
  resolveListedDefaultAccountId,
  resolveMergedAccountConfig,
} from "../channels/plugins/account-helpers.js";
export { normalizeChatType } from "../channels/chat-type.js";
export { resolveAccountEntry, resolveNormalizedAccountEntry } from "../routing/account-lookup.js";
export {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeOptionalAccountId,
} from "../routing/session-key.js";
export { normalizeE164, pathExists, resolveUserPath } from "../utils.js";
export { listConfiguredAccountIds } from "./account-configured-ids.js";

/** Resolve an account by id, then fall back to the default account when the primary lacks credentials. */
export function resolveAccountWithDefaultFallback<TAccount>(params: {
  /** Requested account id; omitted means callers may prefer a credentialed default account. */
  accountId?: string | null;
  /** Channel-owned normalization keeps account aliases consistent with that plugin's config shape. */
  normalizeAccountId: (accountId?: string | null) => string;
  /** Resolve the normalized account without applying default-account credential fallback. */
  resolvePrimary: (accountId: string) => TAccount;
  /** True when the resolved account has usable auth material for runtime or status paths. */
  hasCredential: (account: TAccount) => boolean;
  /** Resolve the configured default account id after plugin-specific default selection rules. */
  resolveDefaultAccountId: () => string;
}): TAccount {
  const hasExplicitAccountId = Boolean(params.accountId?.trim());
  const normalizedAccountId = params.normalizeAccountId(params.accountId);
  const primary = params.resolvePrimary(normalizedAccountId);
  if (hasExplicitAccountId || params.hasCredential(primary)) {
    // Explicit account requests must not borrow credentials from another account;
    // only omitted ids get the default-account credential fallback.
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
