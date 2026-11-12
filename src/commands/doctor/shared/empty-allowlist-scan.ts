import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  getDoctorChannelCapabilities,
  resolveDoctorChannelAccountIds,
} from "../channel-capabilities.js";
import type { DoctorAccountRecord } from "../types.js";
import { hasAllowFromEntries } from "./allowlist.js";
import type { ChannelDoctorEmptyAllowlistPolicyHooks } from "./channel-doctor.js";

type ScanEmptyAllowlistPolicyWarningsParams = Partial<ChannelDoctorEmptyAllowlistPolicyHooks> & {
  doctorFixCommand: string;
  env?: NodeJS.ProcessEnv;
};

function resolveDoctorAccountDmAccess(account: DoctorAccountRecord, parent?: DoctorAccountRecord) {
  const dm = asNullableRecord(account.dm);
  const parentDm = asNullableRecord(parent?.dm);
  return {
    dmPolicy: account.dmPolicy ?? dm?.policy ?? parent?.dmPolicy ?? parentDm?.policy ?? undefined,
    // Doctor's legacy warnings prefer top-level allowlists, including inherited ones.
    effectiveAllowFrom:
      account.allowFrom ?? parent?.allowFrom ?? dm?.allowFrom ?? parentDm?.allowFrom,
  };
}

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
      dmPolicy: typeof dmPolicy === "string" ? dmPolicy : undefined,
      effectiveAllowFrom: Array.isArray(effectiveAllowFrom) ? effectiveAllowFrom : undefined,
      parent,
      prefix,
    };
    if (dmPolicy === "allowlist" && !hasAllowFromEntries(effectiveAllowFrom)) {
      warnings.push(
        `- ${prefix}.dmPolicy is "allowlist" but allowFrom is empty — all DMs will be blocked. Add sender IDs to ${prefix}.allowFrom, or run "${params.doctorFixCommand}" to auto-migrate from pairing store when entries exist.`,
      );
    }
    const groupPolicy = account.groupPolicy ?? parent?.groupPolicy;
    if (
      groupPolicy === "allowlist" &&
      getDoctorChannelCapabilities(channelName).warnOnEmptyGroupSenderAllowlist &&
      !(
        channelName &&
        (options.suppressGroupAllowlistWarning ||
          params.shouldSkipDefaultEmptyGroupAllowlistWarning?.({ ...context }))
      )
    ) {
      const rawGroupAllowFrom = account.groupAllowFrom ?? parent?.groupAllowFrom;
      // Match runtime semantics: resolveGroupAllowFromSources treats empty arrays as
      // unset and falls back to allowFrom.
      const groupAllowFrom = hasAllowFromEntries(rawGroupAllowFrom) ? rawGroupAllowFrom : undefined;
      const fallbackToAllowFrom =
        getDoctorChannelCapabilities(channelName).groupAllowFromFallbackToAllowFrom;
      const effectiveGroupAllowFrom =
        groupAllowFrom ?? (fallbackToAllowFrom ? effectiveAllowFrom : undefined);
      if (!hasAllowFromEntries(effectiveGroupAllowFrom)) {
        warnings.push(
          fallbackToAllowFrom
            ? `- ${prefix}.groupPolicy is "allowlist" but groupAllowFrom (and allowFrom) is empty — all group messages will be silently dropped. Add sender IDs to ${prefix}.groupAllowFrom or ${prefix}.allowFrom, or set groupPolicy to "open".`
            : `- ${prefix}.groupPolicy is "allowlist" but groupAllowFrom is empty — this channel does not fall back to allowFrom, so all group messages will be silently dropped. Add sender IDs to ${prefix}.groupAllowFrom, or set groupPolicy to "open".`,
        );
      }
    }
    warnings.push(...(params.extraWarningsForAccount?.(context) ?? []));
  };

  for (const [channelName, channelConfig] of Object.entries(channels)) {
    if (!isActiveAccount(channelConfig)) {
      continue;
    }
    const accounts = asNullableRecord(channelConfig.accounts);
    const activeAccounts = Object.values(accounts ?? {}).filter(isActiveAccount);
    const accountIds = await resolveDoctorChannelAccountIds(
      channelName,
      cfg,
      Object.keys(accounts ?? {}),
      { env: params.env },
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
        const rawGroupAllowFrom = account.groupAllowFrom ?? channelConfig.groupAllowFrom;
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
