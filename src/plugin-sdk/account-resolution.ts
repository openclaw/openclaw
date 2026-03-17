export type { OpenClawConfig } from "../config/config.js";

export { createAccountActionGate } from "../channels/plugins/account-action-gate.js";
export { createAccountListHelpers } from "../channels/plugins/account-helpers.js";
export { normalizeChatType } from "../channels/chat-type.js";
export { resolveAccountEntry } from "../routing/account-lookup.js";
export {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeOptionalAccountId,
} from "../routing/session-key.js";
export { normalizeE164, pathExists, resolveUserPath } from "../utils.js";
export {
  resolveDiscordAccount,
  type ResolvedDiscordAccount,
} from "../../extensions/discord/src/accounts.js";
export {
  resolveSlackAccount,
  type ResolvedSlackAccount,
} from "../../extensions/slack/src/accounts.js";
export {
  resolveTelegramAccount,
  type ResolvedTelegramAccount,
} from "../../extensions/telegram/src/accounts.js";
export {
  resolveSignalAccount,
  type ResolvedSignalAccount,
} from "../../extensions/signal/src/accounts.js";

/** Resolve an account by id, then fall back to the default account when the primary lacks credentials. */
export function resolveAccountWithDefaultFallback<TAccount>(params: {
  accountId?: string | null;
  normalizeAccountId: (accountId?: string | null) => string;
  resolvePrimary: (accountId: string) => TAccount;
  hasCredential: (account: TAccount) => boolean;
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

/** List normalized configured account ids from a raw channel account record map. */
export function listConfiguredAccountIds(params: {
  accounts: Record<string, unknown> | undefined;
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
    ids.add(params.normalizeAccountId(key));
  }
  return [...ids];
}
