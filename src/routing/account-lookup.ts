// Account lookup helpers resolve route accounts from normalized account ids.
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { snapshotReaderSlot } from "../plugins/plugin-metadata-snapshot-readers.js";
import {
  normalizeAccountId as normalizeRoutingAccountId,
  normalizeOptionalAccountId,
} from "./account-id.js";

export type ChannelAccountKeyPolicy = {
  canonicalAliasesRequireOwnField: string;
};

/** Uses the prepared channel owner policy; discovery and account state stay outside lookup. */
export function resolveChannelAccountKey<T>(
  accounts: Record<string, T> | undefined,
  accountId: string,
  channelId: string,
  normalizeAccountId: ((accountId: string) => string) | undefined,
  accountKeyPolicy: ChannelAccountKeyPolicy | undefined,
  options: { allowMissing: true },
): string;
export function resolveChannelAccountKey<T>(
  accounts: Record<string, T> | undefined,
  accountId: string,
  channelId: string,
  normalizeAccountId?: (accountId: string) => string,
  accountKeyPolicy?: ChannelAccountKeyPolicy,
  options?: { allowMissing?: boolean },
): string | undefined;
export function resolveChannelAccountKey<T>(
  accounts: Record<string, T> | undefined,
  accountId: string,
  channelId: string,
  normalizeAccountId?: (accountId: string) => string,
  accountKeyPolicy?: ChannelAccountKeyPolicy,
  options?: { allowMissing?: boolean },
): string | undefined {
  return resolveAccountKey(accounts, accountId, normalizeAccountId, accountKeyPolicy, {
    ...options,
    channelId,
  });
}

export function resolveChannelAccountEntry<T>(
  accounts: Record<string, T> | undefined,
  accountId: string,
  channelId: string,
  normalizeAccountId?: (accountId: string) => string,
  accountKeyPolicy?: ChannelAccountKeyPolicy,
): T | undefined {
  const key = resolveChannelAccountKey(
    accounts,
    accountId,
    channelId,
    normalizeAccountId,
    accountKeyPolicy,
  );
  return key === undefined ? undefined : accounts?.[key];
}

// Case-insensitive account lookup for config maps that may preserve user
// casing. Exact keys win so callers can still distinguish intentional entries.
export function resolveAccountEntry<T>(
  accounts: Record<string, T> | undefined,
  accountId: string,
): T | undefined {
  const key = resolveAccountKey(accounts, accountId);
  return key === undefined ? undefined : accounts?.[key];
}

// Lookup variant for account ids with a channel-specific normalization rule.
// Used when config keys should match the same canonical id as routing state.
export function resolveNormalizedAccountEntry<T>(
  accounts: Record<string, T> | undefined,
  accountId: string,
  normalizeAccountId: (accountId: string) => string,
  policy?: ChannelAccountKeyPolicy,
): T | undefined {
  const key = resolveAccountKey(accounts, accountId, normalizeAccountId, policy);
  return key === undefined ? undefined : accounts?.[key];
}

/** Select the stored spelling once for account readers and writers; exact keys win. */
export function resolveAccountKey<T>(
  accounts: Record<string, T> | undefined,
  accountId: string,
  normalizeAccountId?: (accountId: string) => string,
  policy?: ChannelAccountKeyPolicy,
  options?: { allowMissing?: boolean; channelId?: string },
): string | undefined {
  const effectivePolicy =
    policy ??
    (options?.channelId
      ? snapshotReaderSlot
          .getCurrentPluginMetadataSnapshot?.({
            allowScopedSnapshot: true,
            allowWorkspaceScopedSnapshot: true,
          })
          ?.owners.channelAccountKeyPolicies?.get(options.channelId)
      : undefined);
  const normalizer = effectivePolicy ? normalizeRoutingAccountId : normalizeAccountId;
  const normalize = normalizer ?? normalizeLowercaseStringOrEmpty;
  if (
    options?.allowMissing &&
    (isBlockedObjectKey(normalizeLowercaseStringOrEmpty(accountId)) ||
      isBlockedObjectKey(normalize(accountId)))
  ) {
    throw new Error(`Account id "${accountId}" is reserved. Choose a different account id.`);
  }
  const targetId = effectivePolicy ? normalize(accountId) : accountId;
  // Creation uses the owner's target id, never the spelling of a rejected alias.
  const missingKey = options?.allowMissing ? targetId : undefined;
  if (!accounts || typeof accounts !== "object") {
    return missingKey;
  }
  if (Object.hasOwn(accounts, targetId) && (!normalizer || !isBlockedObjectKey(targetId))) {
    return targetId;
  }
  const normalized = normalize(targetId);
  const lowercaseTarget = normalizeLowercaseStringOrEmpty(targetId);
  let canonicalMatch: string | undefined;
  for (const key of Object.keys(accounts)) {
    if (normalizer && isBlockedObjectKey(key)) {
      continue;
    }
    // Existing case-only matches retain precedence over newly reachable aliases.
    if (effectivePolicy && normalizeLowercaseStringOrEmpty(key) === lowercaseTarget) {
      return key;
    }
    const candidate = normalize(key);
    if (
      (!normalizer ||
        (Boolean(normalizeOptionalAccountId(key)) && !isBlockedObjectKey(candidate))) &&
      candidate === normalized
    ) {
      if (!effectivePolicy) {
        return key;
      }
      const entry = asOptionalRecord(accounts[key]);
      if (
        canonicalMatch === undefined &&
        entry &&
        Object.hasOwn(entry, effectivePolicy.canonicalAliasesRequireOwnField) &&
        normalizeOptionalString(entry[effectivePolicy.canonicalAliasesRequireOwnField])
      ) {
        canonicalMatch = key;
      }
    }
  }
  return canonicalMatch ?? missingKey;
}
