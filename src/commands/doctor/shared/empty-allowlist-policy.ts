import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { ChannelDoctorEmptyAllowlistAccountContext } from "../../../channels/plugins/types.adapters.js";
import { getDoctorChannelCapabilities } from "../channel-capabilities.js";
import type { DoctorAccountRecord, DoctorAllowFromList } from "../types.js";
import { hasAllowFromEntries } from "./allowlist.js";

type CollectEmptyAllowlistPolicyWarningsParams = ChannelDoctorEmptyAllowlistAccountContext & {
  doctorFixCommand: string;
  shouldSkipDefaultEmptyGroupAllowlistWarning: (
    params: ChannelDoctorEmptyAllowlistAccountContext,
  ) => boolean;
};

export function resolveDoctorAccountDmAccess(
  account: DoctorAccountRecord,
  parent?: DoctorAccountRecord,
) {
  const dm = asNullableRecord(account.dm);
  const parentDm = asNullableRecord(parent?.dm);
  return {
    dmPolicy:
      (account.dmPolicy as string | undefined) ??
      (dm?.policy as string | undefined) ??
      (parent?.dmPolicy as string | undefined) ??
      (parentDm?.policy as string | undefined) ??
      undefined,
    // Doctor's legacy warnings prefer top-level allowlists, including inherited ones.
    effectiveAllowFrom:
      (account.allowFrom as DoctorAllowFromList | undefined) ??
      (parent?.allowFrom as DoctorAllowFromList | undefined) ??
      (dm?.allowFrom as DoctorAllowFromList | undefined) ??
      (parentDm?.allowFrom as DoctorAllowFromList | undefined),
  };
}

/** Collect DM/group allowlist warnings for one channel or account config record. */
export function collectEmptyAllowlistPolicyWarningsForAccount(
  params: CollectEmptyAllowlistPolicyWarningsParams,
): string[] {
  const warnings: string[] = [];
  const { dmPolicy, effectiveAllowFrom } = params;

  if (dmPolicy === "allowlist" && !hasAllowFromEntries(effectiveAllowFrom)) {
    warnings.push(
      `- ${params.prefix}.dmPolicy is "allowlist" but allowFrom is empty — all DMs will be blocked. Add sender IDs to ${params.prefix}.allowFrom, or run "${params.doctorFixCommand}" to auto-migrate from pairing store when entries exist.`,
    );
  }

  const groupPolicy =
    (params.account.groupPolicy as string | undefined) ??
    (params.parent?.groupPolicy as string | undefined) ??
    undefined;

  if (
    groupPolicy !== "allowlist" ||
    !getDoctorChannelCapabilities(params.channelName).warnOnEmptyGroupSenderAllowlist
  ) {
    return warnings;
  }

  if (
    params.channelName &&
    params.shouldSkipDefaultEmptyGroupAllowlistWarning({
      account: params.account,
      channelName: params.channelName,
      dmPolicy,
      effectiveAllowFrom,
      parent: params.parent,
      prefix: params.prefix,
    })
  ) {
    return warnings;
  }

  const rawGroupAllowFrom =
    (params.account.groupAllowFrom as DoctorAllowFromList | undefined) ??
    (params.parent?.groupAllowFrom as DoctorAllowFromList | undefined);
  // Match runtime semantics: resolveGroupAllowFromSources treats empty arrays as
  // unset and falls back to allowFrom.
  const groupAllowFrom = hasAllowFromEntries(rawGroupAllowFrom) ? rawGroupAllowFrom : undefined;
  const fallbackToAllowFrom = getDoctorChannelCapabilities(
    params.channelName,
  ).groupAllowFromFallbackToAllowFrom;
  const effectiveGroupAllowFrom =
    groupAllowFrom ?? (fallbackToAllowFrom ? effectiveAllowFrom : undefined);

  if (hasAllowFromEntries(effectiveGroupAllowFrom)) {
    return warnings;
  }

  if (fallbackToAllowFrom) {
    warnings.push(
      `- ${params.prefix}.groupPolicy is "allowlist" but groupAllowFrom (and allowFrom) is empty — all group messages will be silently dropped. Add sender IDs to ${params.prefix}.groupAllowFrom or ${params.prefix}.allowFrom, or set groupPolicy to "open".`,
    );
  } else {
    warnings.push(
      `- ${params.prefix}.groupPolicy is "allowlist" but groupAllowFrom is empty — this channel does not fall back to allowFrom, so all group messages will be silently dropped. Add sender IDs to ${params.prefix}.groupAllowFrom, or set groupPolicy to "open".`,
    );
  }

  return warnings;
}
