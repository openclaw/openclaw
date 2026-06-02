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

/**
 * Resolve an account by id, then fall back to the default account when the primary lacks credentials.
 *
 * Explicit account ids are never redirected; the fallback only applies to implicit default lookups
 * so channel callers can preserve user-selected accounts even when credentials are missing.
 */
export function resolveAccountWithDefaultFallback<TAccount>(params: {
  /** Requested account id from the caller; blank/null means the channel's implicit default. */
  accountId?: string | null;
  /** Channel-owned account id normalizer, usually preserving the product-level default id. */
  normalizeAccountId: (accountId?: string | null) => string;
  /** Resolve one normalized account id into the channel-specific account shape. */
  resolvePrimary: (accountId: string) => TAccount;
  /** Credential presence check for deciding whether an implicit lookup should try the configured default. */
  hasCredential: (account: TAccount) => boolean;
  /** Channel-specific configured default account id, already normalized by the caller. */
  resolveDefaultAccountId: () => string;
}): TAccount {
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
