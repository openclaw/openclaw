// Doctor scanner for empty allowlist policies across configured channels and accounts.
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
    skipGroupAllowFromWarning?: boolean,
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
        skipGroupAllowFromWarning,
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

    const accounts = asObjectRecord(channelConfig.accounts);
    const hasAccounts = accounts && Object.keys(accounts).length > 0;

    // When accounts exist, check the top-level config but skip the groupAllowFrom
    // warning if every enabled account has its own populated allowlist.
    // This preserves DM warnings and channel extra-warning hooks.
    if (hasAccounts) {
      // Check if every enabled account has its own groupAllowFrom or allowFrom
      const allAccountsCovered = Object.values(accounts).every((account) => {
        if (!account || typeof account !== "object") {
          return false;
        }
        if (isDisabledRecord(account)) {
          return true; // Skip disabled accounts
        }
        const acc = account as DoctorAccountRecord;
        const groupAllowFrom = acc.groupAllowFrom as DoctorAllowFromList | undefined;
        const allowFrom = acc.allowFrom as DoctorAllowFromList | undefined;
        const hasGroupAllowFrom =
          groupAllowFrom && Array.isArray(groupAllowFrom) && groupAllowFrom.length > 0;
        const hasAllowFrom = allowFrom && Array.isArray(allowFrom) && allowFrom.length > 0;
        return hasGroupAllowFrom || hasAllowFrom;
      });

      // Check if there's an implicit default account (e.g. Telegram with botToken/tokenFile)
      // that is not explicitly listed in accounts
      const hasImplicitDefaultAccount =
        channelName === "telegram" &&
        (channelConfig.botToken || channelConfig.tokenFile || channelConfig.token);
      const hasExplicitDefaultAccount = accounts.default !== undefined;

      // Only skip the groupAllowFrom warning if:
      // 1. All explicit accounts are covered, AND
      // 2. There's no implicit default account that isn't covered
      const shouldSkipGroupWarning =
        allAccountsCovered && !(hasImplicitDefaultAccount && !hasExplicitDefaultAccount);

      // Always check the top-level config (preserves DM warnings and hooks)
      // but pass a flag to skip the groupAllowFrom warning if covered
      checkAccount(
        channelConfig,
        `channels.${channelName}`,
        channelName,
        undefined,
        shouldSkipGroupWarning,
      );
    } else {
      checkAccount(channelConfig, `channels.${channelName}`, channelName);
    }

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
