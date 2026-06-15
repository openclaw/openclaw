// Doctor scanner for empty allowlist policies across configured channels and accounts.
import type { ChannelDoctorEmptyAllowlistAccountContext } from "../../../channels/plugins/types.adapters.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { getDoctorChannelCapabilities } from "../channel-capabilities.js";
import type { DoctorAccountRecord, DoctorAllowFromList } from "../types.js";
import { hasAllowFromEntries } from "./allowlist.js";
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
    // When every child account has its own populated group allowlist source,
    // the runtime resolves account ?? parent and never reads an empty parent
    // list. Skip the false group-policy warning at parent scope while still
    // checking DM policy. Honor fallback-capable channels where account
    // allowFrom serves as the effective group sender allowlist.
    const channelAccounts = asObjectRecord(channelConfig.accounts);
    const hasAccounts = channelAccounts && Object.keys(channelAccounts).length > 0;

    if (hasAccounts) {
      const caps = getDoctorChannelCapabilities(channelName);
      const allAccountsOverrideEffectiveGroupAllowFrom = Object.values(channelAccounts).every(
        (acc) => {
          if (!acc || typeof acc !== "object") {
            return false;
          }
          // Disabled accounts don't need to override — they're inactive.
          if ((acc as { enabled?: unknown }).enabled === false) {
            return true;
          }
          const record = acc as DoctorAccountRecord;
          // Explicit groupAllowFrom always counts
          if (hasAllowFromEntries(record.groupAllowFrom as DoctorAllowFromList | undefined)) {
            return true;
          }
          // For fallback-capable channels, account-level allowFrom
          // serves as the effective group sender allowlist.
          if (caps.groupAllowFromFallbackToAllowFrom) {
            return hasAllowFromEntries(record.allowFrom as DoctorAllowFromList | undefined);
          }
          return false;
        },
      );

      if (allAccountsOverrideEffectiveGroupAllowFrom) {
        // Strip groupPolicy so collectEmptyAllowlistPolicyWarningsForAccount skips
        // the group-allowlist check — only DM-level warnings remain for the parent.
        checkAccount(
          { ...channelConfig, groupPolicy: undefined } as DoctorAccountRecord,
          `channels.${channelName}`,
          channelName,
        );
      } else {
        checkAccount(channelConfig, `channels.${channelName}`, channelName);
      }
    } else {
      checkAccount(channelConfig, `channels.${channelName}`, channelName);
    }

    const accounts = channelAccounts;
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
