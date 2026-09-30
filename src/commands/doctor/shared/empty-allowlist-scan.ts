import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { ChannelDoctorEmptyAllowlistAccountContext } from "../../../channels/plugins/types.adapters.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  getDoctorChannelCapabilities,
  resolveDoctorChannelAccountIds,
} from "../channel-capabilities.js";
import type { DoctorAccountRecord, DoctorAllowFromList } from "../types.js";
import { hasAllowFromEntries } from "./allowlist.js";
import {
  collectEmptyAllowlistPolicyWarningsForAccount,
  resolveDoctorAccountDmAccess,
} from "./empty-allowlist-policy.js";

type ScanEmptyAllowlistPolicyWarningsParams = {
  doctorFixCommand: string;
  extraWarningsForAccount?: (params: ChannelDoctorEmptyAllowlistAccountContext) => string[];
  shouldSkipDefaultEmptyGroupAllowlistWarning?: (
    params: ChannelDoctorEmptyAllowlistAccountContext,
  ) => boolean;
};

function isDisabledRecord(value: unknown): boolean {
  return asNullableRecord(value)?.enabled === false;
}

/** Scan all configured channels/accounts for empty allowlist policy warnings. */
export async function scanEmptyAllowlistPolicyWarnings(
  cfg: OpenClawConfig,
  params: ScanEmptyAllowlistPolicyWarningsParams,
): Promise<string[]> {
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
    options: { suppressGroupAllowlistWarning?: boolean } = {},
  ) => {
    const { dmPolicy, effectiveAllowFrom } = resolveDoctorAccountDmAccess(account, parent);
    warnings.push(
      ...collectEmptyAllowlistPolicyWarningsForAccount({
        account,
        channelName,
        cfg,
        doctorFixCommand: params.doctorFixCommand,
        parent,
        prefix,
        shouldSkipDefaultEmptyGroupAllowlistWarning: (context) =>
          options.suppressGroupAllowlistWarning ||
          Boolean(params.shouldSkipDefaultEmptyGroupAllowlistWarning?.(context)),
      }),
    );
    if (params.extraWarningsForAccount) {
      warnings.push(
        ...params.extraWarningsForAccount({
          account,
          channelName,
          dmPolicy,
          effectiveAllowFrom: effectiveAllowFrom ?? undefined,
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
    const accounts = asNullableRecord(channelConfig.accounts);
    const activeAccounts = accounts
      ? Object.values(accounts).filter((account): account is DoctorAccountRecord =>
          Boolean(account && typeof account === "object" && !isDisabledRecord(account)),
        )
      : [];
    const accountIds = await resolveDoctorChannelAccountIds(
      channelName,
      cfg,
      Object.keys(accounts ?? {}),
    );
    const configuredAccountIds = new Set(accountIds?.configured);
    const hasImplicitActiveAccount =
      accountIds === undefined ||
      accountIds.runtime.some((accountId) => !configuredAccountIds.has(accountId));
    const suppressParentGroupAllowlistWarning =
      activeAccounts.length > 0 &&
      !hasImplicitActiveAccount &&
      channelConfig.groupPolicy === "allowlist" &&
      activeAccounts.every((account) => {
        const rawGroupAllowFrom =
          (account.groupAllowFrom as DoctorAllowFromList | undefined) ??
          (channelConfig.groupAllowFrom as DoctorAllowFromList | undefined);
        if (hasAllowFromEntries(rawGroupAllowFrom)) {
          return true;
        }
        if (!getDoctorChannelCapabilities(channelName).groupAllowFromFallbackToAllowFrom) {
          return false;
        }
        const { effectiveAllowFrom } = resolveDoctorAccountDmAccess(account, channelConfig);
        return hasAllowFromEntries(effectiveAllowFrom);
      });

    checkAccount(channelConfig, `channels.${channelName}`, channelName, undefined, {
      suppressGroupAllowlistWarning: suppressParentGroupAllowlistWarning,
    });

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
