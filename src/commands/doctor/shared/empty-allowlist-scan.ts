// Doctor scanner for empty allowlist policies across configured channels and accounts.
import type { ChannelDoctorEmptyAllowlistAccountContext } from "../../../channels/plugins/types.adapters.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
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
    skipGroupAllowlistCheck?: boolean,
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
        skipGroupAllowlistCheck,
        shouldSkipDefaultEmptyGroupAllowlistWarning:
          params.shouldSkipDefaultEmptyGroupAllowlistWarning,
      }),
    );
    // Plugin-specific extra warnings (e.g. Telegram's group-allowlist check)
    // run for real accounts and for the top-level when no accounts exist.
    // When sub-accounts are present the top-level is a parent/fallback, so
    // skip extra warnings for it to avoid false positives on empty top-level
    // groupAllowFrom.
    if (params.extraWarningsForAccount && !skipGroupAllowlistCheck) {
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

    // When every non-disabled sub-account carries its own populated
    // groupAllowFrom (or allowFrom on fallback channels), the top-level's
    // empty groupAllowFrom is an unused parent/fallback and should not
    // trigger a warning.  If any account lacks its own list and relies on
    // the top-level, the warning is still legitimate.
    // When the top-level record has its own credentials (e.g. botToken on
    // Telegram, token on other channels) it is an active account, not just a
    // parent/fallback.  Preserve the warning so operators don't miss empty
    // groupAllowFrom on the implicit default account.
    const topLevelHasCredentials =
      channelConfig &&
      typeof channelConfig === "object" &&
      Object.keys(channelConfig).some(
        (k) =>
          k !== "accounts" &&
          k !== "enabled" &&
          k !== "groupPolicy" &&
          k !== "dmPolicy" &&
          k !== "groupAllowFrom" &&
          k !== "allowFrom" &&
          k !== "groups" &&
          k !== "channels" &&
          k !== "defaultAccount" &&
          !k.startsWith("_") &&
          typeof (channelConfig as Record<string, unknown>)[k] === "string",
      );

    // When the `default` account is present, the top-level config is also
    // an active account (not just a parent/fallback).
    const hasDefaultAccount =
      accounts && "default" in accounts && !isDisabledRecord(accounts["default"]);

    const allAccountsHaveOwnAllowFrom =
      !topLevelHasCredentials &&
      !hasDefaultAccount &&
      accounts &&
      Object.keys(accounts).length > 0 &&
      (() => {
        let hasEnabledAccount = false;
        for (const id of Object.keys(accounts)) {
          if (isDisabledRecord(accounts[id])) {
            continue;
          }
          hasEnabledAccount = true;
          const acct = accounts[id] as DoctorAccountRecord;
          const ownGroupAllowFrom = acct.groupAllowFrom as DoctorAllowFromList | undefined;
          const ownAllowFrom = acct.allowFrom as DoctorAllowFromList | undefined;
          // groupAllowFrom: [] (explicit empty array) is falsy for
          // hasAllowFromEntries, so check both fields separately —
          // a populated allowFrom covers the account on channels that
          // support groupAllowFromFallbackToAllowFrom.
          if (!hasAllowFromEntries(ownGroupAllowFrom) && !hasAllowFromEntries(ownAllowFrom)) {
            return false;
          }
        }
        return hasEnabledAccount;
      })();

    checkAccount(
      channelConfig,
      `channels.${channelName}`,
      channelName,
      undefined,
      allAccountsHaveOwnAllowFrom ? true : undefined,
    );

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
