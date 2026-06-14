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
    // When sub-accounts exist and the top-level has no allowFrom entries or
    // credentials of its own, it is just a parent/fallback — skip the
    // false-positive group-allowlist warning.
    // Implicit default accounts (created by top-level botToken, tokenFile, or
    // SecretRef credentials) are active accounts — preserve their warnings.
    const parentHasOwnAllowFrom =
      hasAllowFromEntries(channelConfig.groupAllowFrom as DoctorAllowFromList | undefined) ||
      hasAllowFromEntries(channelConfig.allowFrom as DoctorAllowFromList | undefined);
    const parentHasCredentials =
      channelConfig &&
      typeof channelConfig === "object" &&
      Object.keys(channelConfig).some((k) => {
        if (
          k === "accounts" ||
          k === "enabled" ||
          k === "groupPolicy" ||
          k === "dmPolicy" ||
          k === "groupAllowFrom" ||
          k === "allowFrom" ||
          k === "groups" ||
          k === "channels" ||
          k === "defaultAccount" ||
          k === "name" ||
          k.startsWith("_")
        ) {
          return false;
        }
        const v = (channelConfig as Record<string, unknown>)[k];
        // SecretRef credentials e.g. { env: "TELEGRAM_BOT_TOKEN" }
        if (v && typeof v === "object" && !Array.isArray(v)) {
          return "env" in v || "file" in v || "raw" in v || "command" in v;
        }
        // Plain-text credential strings e.g. botToken, tokenFile, apiKey
        return typeof v === "string" && v.length > 0;
      });

    const hasActiveAccounts =
      accounts && Object.keys(accounts).some((id) => !isDisabledRecord(accounts[id]));

    checkAccount(
      channelConfig,
      `channels.${channelName}`,
      channelName,
      undefined,
      hasActiveAccounts && !parentHasOwnAllowFrom && !parentHasCredentials ? true : undefined,
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
