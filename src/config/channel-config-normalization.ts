import { asNullableRecord as asObjectRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  CompatMutationResult,
  NormalizeChannelConfigEntryParams,
  NormalizeLegacyChannelAccountParams,
} from "./channel-compat-normalization.js";
import type { OpenClawConfig } from "./types.openclaw.js";

/** Applies one channel-specific doctor migration to every object-shaped account. */
export function normalizeChannelAccounts(params: {
  entry: Record<string, unknown>;
  pathPrefix: string;
  changes: string[];
  normalizeAccount: (params: NormalizeLegacyChannelAccountParams) => CompatMutationResult;
}): CompatMutationResult {
  const rawAccounts = asObjectRecord(params.entry.accounts);
  if (!rawAccounts) {
    return { entry: params.entry, changed: false };
  }
  let changed = false;
  const accounts = { ...rawAccounts };
  for (const [accountId, value] of Object.entries(rawAccounts)) {
    const account = asObjectRecord(value);
    if (!account) {
      continue;
    }
    const normalized = params.normalizeAccount({
      account,
      accountId,
      pathPrefix: `${params.pathPrefix}.accounts.${accountId}`,
      changes: params.changes,
    });
    if (normalized.changed) {
      accounts[accountId] = normalized.entry;
      changed = true;
    }
  }
  return changed
    ? { entry: { ...params.entry, accounts }, changed: true }
    : { entry: params.entry, changed: false };
}

/** Applies the same channel-specific doctor migration at root and account scope. */
export function normalizeChannelConfigEntries(params: {
  cfg: OpenClawConfig;
  channelId: string;
  changes?: string[];
  normalizeEntry: (params: NormalizeChannelConfigEntryParams) => CompatMutationResult;
}): { config: OpenClawConfig; changes: string[] } {
  const changes = params.changes ?? [];
  const channels = params.cfg.channels;
  const entry = asObjectRecord(channels?.[params.channelId]);
  if (!entry) {
    return { config: params.cfg, changes };
  }
  const channelPath = `channels.${params.channelId}`;
  const root = params.normalizeEntry({ entry, pathPrefix: channelPath, changes });
  const accounts = normalizeChannelAccounts({
    entry: root.entry,
    pathPrefix: channelPath,
    changes,
    normalizeAccount: (accountParams) =>
      params.normalizeEntry({
        entry: accountParams.account,
        accountId: accountParams.accountId,
        pathPrefix: accountParams.pathPrefix,
        changes: accountParams.changes,
      }),
  });
  if (!root.changed && !accounts.changed) {
    return { config: params.cfg, changes };
  }
  return {
    config: {
      ...params.cfg,
      channels: { ...channels, [params.channelId]: accounts.entry },
    },
    changes,
  };
}
