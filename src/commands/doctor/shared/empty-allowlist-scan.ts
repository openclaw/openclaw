import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  getDoctorChannelCapabilities,
  resolveDoctorChannelAccountIds,
} from "../channel-capabilities.js";
import type { DoctorAccountRecord, DoctorAllowFromList } from "../types.js";
import { hasAllowFromEntries } from "./allowlist.js";
import type { ChannelDoctorEmptyAllowlistPolicyHooks } from "./channel-doctor.js";
import {
  collectEmptyAllowlistPolicyWarningsForAccount,
  resolveDoctorAccountDmAccess,
} from "./empty-allowlist-policy.js";

type ScanEmptyAllowlistPolicyWarningsParams = Partial<ChannelDoctorEmptyAllowlistPolicyHooks> & {
  doctorFixCommand: string;
};

function isActiveAccount(value: unknown): value is DoctorAccountRecord {
  return Boolean(value && typeof value === "object" && asNullableRecord(value)?.enabled !== false);
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
    const context = {
      account,
      channelName,
      dmPolicy,
      effectiveAllowFrom: effectiveAllowFrom ?? undefined,
      parent,
      prefix,
    };
    warnings.push(
      ...collectEmptyAllowlistPolicyWarningsForAccount({
        ...context,
        doctorFixCommand: params.doctorFixCommand,
        shouldSkipDefaultEmptyGroupAllowlistWarning: (accountContext) =>
          options.suppressGroupAllowlistWarning ||
          Boolean(params.shouldSkipDefaultEmptyGroupAllowlistWarning?.(accountContext)),
      }),
    );
    warnings.push(...(params.extraWarningsForAccount?.(context) ?? []));
  };

  for (const [channelName, channelConfig] of Object.entries(
    channels as Record<string, DoctorAccountRecord>,
  )) {
    if (!isActiveAccount(channelConfig)) {
      continue;
    }
    const accounts = asNullableRecord(channelConfig.accounts);
    const activeAccounts = Object.values(accounts ?? {}).filter(isActiveAccount);
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
      if (!isActiveAccount(account)) {
        continue;
      }
      checkAccount(
        account,
        `channels.${channelName}.accounts.${accountId}`,
        channelName,
        channelConfig,
      );
    }
  }

  return warnings;
}
