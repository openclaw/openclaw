// Doctor scanner for empty allowlist policies across configured channels and accounts.
import { hasAllowFromEntries } from "./allowlist.js";
import type { ChannelDoctorEmptyAllowlistAccountContext } from "../../../channels/plugins/types.adapters.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { DoctorAccountRecord, DoctorAllowFromList } from "../types.js";
import { collectEmptyAllowlistPolicyWarningsForAccount } from "./empty-allowlist-policy.js";
import { asObjectRecord } from "./object.js";

type ScanEmptyAllowlistPolicyWarningsParams = {
  doctorFixCommand: string;
  extraWarningsForAccount?: (params: ChannelDoctorEmptyAllowlistAccountContext) => string[];
  shouldSkipDefaultEmptyGroupAllowlistWarning?: (
    params: ChannelDoctorEmptyAllowlistAccountContext,
  ) => boolean;
};

function isDisabledRecord(value: unknown): boolean {
  return (
    Boolean(value && typeof value === "object" && !Array.isArray(value)) &&
    (value as { enabled?: unknown }).enabled === false
  );
}

/**
 * Check whether every non-disabled account under a channel has its own
 * populated allowlist (groupAllowFrom or allowFrom), so the top-level
 * channel group allowlist warning is a false positive — group messages
 * are already covered by per-account entries.
 */
function allTopLevelAccountsCoverGroupPolicy(
  channelConfig: DoctorAccountRecord,
): boolean {
  const accounts = asObjectRecord(channelConfig.accounts);
  if (!accounts || Object.keys(accounts).length === 0) {
    return false;
  }

  let hasEnabledAccount = false;

  for (const account of Object.values(accounts)) {
    if (!account || typeof account !== "object") {
      continue;
    }
    if (isDisabledRecord(account)) {
      continue;
    }
    hasEnabledAccount = true;

    const acct = account as DoctorAccountRecord;
    const rawGroupAllowFrom = acct.groupAllowFrom as DoctorAllowFromList | undefined;
    const rawAllowFrom = acct.allowFrom as DoctorAllowFromList | undefined;
    const acctDm = asObjectRecord(acct.dm);
    const acctDmAllowFrom = acctDm?.allowFrom as DoctorAllowFromList | undefined;
    if (
      hasAllowFromEntries(rawGroupAllowFrom) ||
      hasAllowFromEntries(rawAllowFrom) ||
      hasAllowFromEntries(acctDmAllowFrom)
    ) {
      continue;
    }

    return false;
  }

  return hasEnabledAccount;
}

/** Scan all configured channels/accounts for empty allowlist policy warnings. */
export function scanEmptyAllowlistPolicyWarnings(
  cfg: OpenClawConfig,
  params: ScanEmptyAllowlistPolicyWarningsParams,
): string[] {
  const channels = cfg.channels;
  if (!channels || typeof channels !== "object") {
    return [];
  }

  const warnings: string[] = [];

  const checkAccount = (
    account: DoctorAccountRecord,
    prefix: string,
    channelName: string,
    parent?: DoctorAccountRecord,
  ) => {
    const accountDm = asObjectRecord(account.dm);
    const parentDm = asObjectRecord(parent?.dm);
    const dmPolicy =
      (account.dmPolicy as string | undefined) ??
      (accountDm?.policy as string | undefined) ??
      (parent?.dmPolicy as string | undefined) ??
      (parentDm?.policy as string | undefined) ??
      undefined;
    const effectiveAllowFrom =
      (account.allowFrom as DoctorAllowFromList | undefined) ??
      (parent?.allowFrom as DoctorAllowFromList | undefined) ??
      (accountDm?.allowFrom as DoctorAllowFromList | undefined) ??
      (parentDm?.allowFrom as DoctorAllowFromList | undefined) ??
      undefined;

    warnings.push(
      ...collectEmptyAllowlistPolicyWarningsForAccount({
        account,
        channelName,
        cfg,
        doctorFixCommand: params.doctorFixCommand,
        parent,
        prefix,
        shouldSkipDefaultEmptyGroupAllowlistWarning:
          params.shouldSkipDefaultEmptyGroupAllowlistWarning,
      }),
    );
    if (params.extraWarningsForAccount) {
      warnings.push(
        ...params.extraWarningsForAccount({
          account,
          channelName,
          dmPolicy,
          effectiveAllowFrom,
          parent,
          prefix,
        }),
      );
    }
  };

  for (const [channelName, channelConfig] of Object.entries(
    channels as Record<string, DoctorAccountRecord>,
  )) {
    if (!channelConfig || typeof channelConfig !== "object") {
      continue;
    }
    if (isDisabledRecord(channelConfig)) {
      continue;
    }
    // When every non-disabled account has its own populated allowlist, skip
    // the top-level checkAccount — its group allowlist warning would be a
    // false positive since per-account entries handle group message routing.
    // Per-account checks still run to catch per-account issues.
    const accountsAreCovered = allTopLevelAccountsCoverGroupPolicy(channelConfig);

    if (!accountsAreCovered) {
      checkAccount(channelConfig, `channels.${channelName}`, channelName);
    }

    const accounts = asObjectRecord(channelConfig.accounts);
    if (!accounts) {
      continue;
    }
    for (const [accountId, account] of Object.entries(accounts)) {
      if (!account || typeof account !== "object") {
        continue;
      }
      if (isDisabledRecord(account)) {
        continue;
      }
      checkAccount(
        account as DoctorAccountRecord,
        `channels.${channelName}.accounts.${accountId}`,
        channelName,
        channelConfig,
      );
    }
  }

  return warnings;
}
