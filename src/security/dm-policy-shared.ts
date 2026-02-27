import { mergeDmAllowFromSources, resolveGroupAllowFromSources } from "../channels/allow-from.js";
import { resolveControlCommandGate } from "../channels/command-gating.js";
import type { ChannelId } from "../channels/plugins/types.js";
import { readChannelAllowFromStore } from "../pairing/pairing-store.js";
import { normalizeStringEntries } from "../shared/string-normalization.js";

export function resolveEffectiveAllowFromLists(params: {
  allowFrom?: Array<string | number> | null;
  groupAllowFrom?: Array<string | number> | null;
  storeAllowFrom?: Array<string | number> | null;
  dmPolicy?: string | null;
  groupAllowFromFallbackToAllowFrom?: boolean | null;
}): {
  effectiveAllowFrom: string[];
  effectiveGroupAllowFrom: string[];
} {
  const allowFrom = Array.isArray(params.allowFrom) ? params.allowFrom : undefined;
  const groupAllowFrom = Array.isArray(params.groupAllowFrom) ? params.groupAllowFrom : undefined;
  const storeAllowFrom = Array.isArray(params.storeAllowFrom) ? params.storeAllowFrom : undefined;
  const effectiveAllowFrom = normalizeStringEntries(
    mergeDmAllowFromSources({
      allowFrom,
      storeAllowFrom,
      dmPolicy: params.dmPolicy ?? undefined,
    }),
  );
  // Group auth is explicit (groupAllowFrom fallback allowFrom). Pairing store is DM-only.
  const effectiveGroupAllowFrom = normalizeStringEntries(
    resolveGroupAllowFromSources({
      allowFrom,
      groupAllowFrom,
      fallbackToAllowFrom: params.groupAllowFromFallbackToAllowFrom ?? undefined,
    }),
  );
  return { effectiveAllowFrom, effectiveGroupAllowFrom };
}

export type DmGroupAccessDecision = "allow" | "block" | "pairing";
export const DM_GROUP_ACCESS_REASON = {
  GROUP_POLICY_ALLOWED: "group_policy_allowed",
  GROUP_POLICY_DISABLED: "group_policy_disabled",
  GROUP_POLICY_EMPTY_ALLOWLIST: "group_policy_empty_allowlist",
  GROUP_POLICY_NOT_ALLOWLISTED: "group_policy_not_allowlisted",
  DM_POLICY_OPEN: "dm_policy_open",
  DM_POLICY_DISABLED: "dm_policy_disabled",
  DM_POLICY_ALLOWLISTED: "dm_policy_allowlisted",
  DM_POLICY_PAIRING_REQUIRED: "dm_policy_pairing_required",
  DM_POLICY_NOT_ALLOWLISTED: "dm_policy_not_allowlisted",
} as const;
export type DmGroupAccessReasonCode =
  (typeof DM_GROUP_ACCESS_REASON)[keyof typeof DM_GROUP_ACCESS_REASON];

export async function readStoreAllowFromForDmPolicy(params: {
  provider: ChannelId;
  accountId: string;
  dmPolicy?: string | null;
  shouldRead?: boolean | null;
  readStore?: (provider: ChannelId, accountId: string) => Promise<string[]>;
}): Promise<string[]> {
  if (params.shouldRead === false || params.dmPolicy === "allowlist") {
    return [];
  }
  const readStore =
    params.readStore ??
    ((provider: ChannelId, accountId: string) =>
      readChannelAllowFromStore(provider, process.env, accountId));
  return await readStore(params.provider, params.accountId).catch(() => []);
}

export function resolveDmGroupAccessDecision(params: {
  isGroup: boolean;
  dmPolicy?: string | null;
  groupPolicy?: string | null;
  effectiveAllowFrom: Array<string | number>;
  effectiveGroupAllowFrom: Array<string | number>;
  isSenderAllowed: (allowFrom: string[]) => boolean;
}): {
  decision: DmGroupAccessDecision;
  reasonCode: DmGroupAccessReasonCode;
  reason: string;
} {
  const dmPolicy = params.dmPolicy ?? "pairing";
  const groupPolicy = params.groupPolicy ?? "allowlist";
  const effectiveAllowFrom = normalizeStringEntries(params.effectiveAllowFrom);
  const effectiveGroupAllowFrom = normalizeStringEntries(params.effectiveGroupAllowFrom);

  if (params.isGroup) {
    if (groupPolicy === "disabled") {
      return {
        decision: "block",
        reasonCode: DM_GROUP_ACCESS_REASON.GROUP_POLICY_DISABLED,
        reason: "groupPolicy=disabled",
      };
    }
    if (groupPolicy === "allowlist") {
      if (effectiveGroupAllowFrom.length === 0) {
        return {
          decision: "block",
          reasonCode: DM_GROUP_ACCESS_REASON.GROUP_POLICY_EMPTY_ALLOWLIST,
          reason: "groupPolicy=allowlist (empty allowlist)",
        };
      }
      if (!params.isSenderAllowed(effectiveGroupAllowFrom)) {
        return {
          decision: "block",
          reasonCode: DM_GROUP_ACCESS_REASON.GROUP_POLICY_NOT_ALLOWLISTED,
          reason: "groupPolicy=allowlist (not allowlisted)",
        };
      }
    }
    return {
      decision: "allow",
      reasonCode: DM_GROUP_ACCESS_REASON.GROUP_POLICY_ALLOWED,
      reason: `groupPolicy=${groupPolicy}`,
    };
  }

  if (dmPolicy === "disabled") {
    return {
      decision: "block",
      reasonCode: DM_GROUP_ACCESS_REASON.DM_POLICY_DISABLED,
      reason: "dmPolicy=disabled",
    };
  }
  if (dmPolicy === "open") {
    return {
      decision: "allow",
      reasonCode: DM_GROUP_ACCESS_REASON.DM_POLICY_OPEN,
      reason: "dmPolicy=open",
    };
  }
  if (params.isSenderAllowed(effectiveAllowFrom)) {
    return {
      decision: "allow",
      reasonCode: DM_GROUP_ACCESS_REASON.DM_POLICY_ALLOWLISTED,
      reason: `dmPolicy=${dmPolicy} (allowlisted)`,
    };
  }
  if (dmPolicy === "pairing") {
    return {
      decision: "pairing",
      reasonCode: DM_GROUP_ACCESS_REASON.DM_POLICY_PAIRING_REQUIRED,
      reason: "dmPolicy=pairing (not allowlisted)",
    };
  }
  return {
    decision: "block",
    reasonCode: DM_GROUP_ACCESS_REASON.DM_POLICY_NOT_ALLOWLISTED,
    reason: `dmPolicy=${dmPolicy} (not allowlisted)`,
  };
}

export function resolveDmGroupAccessWithLists(params: {
  isGroup: boolean;
  dmPolicy?: string | null;
  groupPolicy?: string | null;
  allowFrom?: Array<string | number> | null;
  groupAllowFrom?: Array<string | number> | null;
  storeAllowFrom?: Array<string | number> | null;
  groupAllowFromFallbackToAllowFrom?: boolean | null;
  isSenderAllowed: (allowFrom: string[]) => boolean;
}): {
  decision: DmGroupAccessDecision;
  reasonCode: DmGroupAccessReasonCode;
  reason: string;
  effectiveAllowFrom: string[];
  effectiveGroupAllowFrom: string[];
} {
  const { effectiveAllowFrom, effectiveGroupAllowFrom } = resolveEffectiveAllowFromLists({
    allowFrom: params.allowFrom,
    groupAllowFrom: params.groupAllowFrom,
    storeAllowFrom: params.storeAllowFrom,
    dmPolicy: params.dmPolicy,
    groupAllowFromFallbackToAllowFrom: params.groupAllowFromFallbackToAllowFrom,
  });
  const access = resolveDmGroupAccessDecision({
    isGroup: params.isGroup,
    dmPolicy: params.dmPolicy,
    groupPolicy: params.groupPolicy,
    effectiveAllowFrom,
    effectiveGroupAllowFrom,
    isSenderAllowed: params.isSenderAllowed,
  });
  return {
    ...access,
    effectiveAllowFrom,
    effectiveGroupAllowFrom,
  };
}

export function resolveDmGroupAccessWithCommandGate(params: {
  isGroup: boolean;
  dmPolicy?: string | null;
  groupPolicy?: string | null;
  allowFrom?: Array<string | number> | null;
  groupAllowFrom?: Array<string | number> | null;
  storeAllowFrom?: Array<string | number> | null;
  groupAllowFromFallbackToAllowFrom?: boolean | null;
  isSenderAllowed: (allowFrom: string[]) => boolean;
  command?: {
    useAccessGroups: boolean;
    allowTextCommands: boolean;
    hasControlCommand: boolean;
  };
}): {
  decision: DmGroupAccessDecision;
  reason: string;
  effectiveAllowFrom: string[];
  effectiveGroupAllowFrom: string[];
  commandAuthorized: boolean;
  shouldBlockControlCommand: boolean;
} {
  const access = resolveDmGroupAccessWithLists({
    isGroup: params.isGroup,
    dmPolicy: params.dmPolicy,
    groupPolicy: params.groupPolicy,
    allowFrom: params.allowFrom,
    groupAllowFrom: params.groupAllowFrom,
    storeAllowFrom: params.storeAllowFrom,
    groupAllowFromFallbackToAllowFrom: params.groupAllowFromFallbackToAllowFrom,
    isSenderAllowed: params.isSenderAllowed,
  });

  const configuredAllowFrom = normalizeStringEntries(params.allowFrom ?? []);
  const configuredGroupAllowFrom = normalizeStringEntries(
    resolveGroupAllowFromSources({
      allowFrom: configuredAllowFrom,
      groupAllowFrom: normalizeStringEntries(params.groupAllowFrom ?? []),
      fallbackToAllowFrom: params.groupAllowFromFallbackToAllowFrom ?? undefined,
    }),
  );
  // Group command authorization must not inherit DM pairing-store approvals.
  const commandDmAllowFrom = params.isGroup ? configuredAllowFrom : access.effectiveAllowFrom;
  const commandGroupAllowFrom = params.isGroup
    ? configuredGroupAllowFrom
    : access.effectiveGroupAllowFrom;
  const ownerAllowedForCommands = params.isSenderAllowed(commandDmAllowFrom);
  const groupAllowedForCommands = params.isSenderAllowed(commandGroupAllowFrom);
  const commandGate = params.command
    ? resolveControlCommandGate({
        useAccessGroups: params.command.useAccessGroups,
        authorizers: [
          {
            configured: commandDmAllowFrom.length > 0,
            allowed: ownerAllowedForCommands,
          },
          {
            configured: commandGroupAllowFrom.length > 0,
            allowed: groupAllowedForCommands,
          },
        ],
        allowTextCommands: params.command.allowTextCommands,
        hasControlCommand: params.command.hasControlCommand,
      })
    : { commandAuthorized: false, shouldBlock: false };

  return {
    ...access,
    commandAuthorized: commandGate.commandAuthorized,
    shouldBlockControlCommand: params.isGroup && commandGate.shouldBlock,
  };
}

export async function resolveDmAllowState(params: {
  provider: ChannelId;
  accountId: string;
  allowFrom?: Array<string | number> | null;
  normalizeEntry?: (raw: string) => string;
  readStore?: (provider: ChannelId, accountId: string) => Promise<string[]>;
}): Promise<{
  configAllowFrom: string[];
  hasWildcard: boolean;
  allowCount: number;
  isMultiUserDm: boolean;
}> {
  const configAllowFrom = normalizeStringEntries(
    Array.isArray(params.allowFrom) ? params.allowFrom : undefined,
  );
  const hasWildcard = configAllowFrom.includes("*");
  const storeAllowFrom = await readStoreAllowFromForDmPolicy({
    provider: params.provider,
    accountId: params.accountId,
    readStore: params.readStore,
  });
  const normalizeEntry = params.normalizeEntry ?? ((value: string) => value);
  const normalizedCfg = configAllowFrom
    .filter((value) => value !== "*")
    .map((value) => normalizeEntry(value))
    .map((value) => value.trim())
    .filter(Boolean);
  const normalizedStore = storeAllowFrom
    .map((value) => normalizeEntry(value))
    .map((value) => value.trim())
    .filter(Boolean);
  const allowCount = Array.from(new Set([...normalizedCfg, ...normalizedStore])).length;
  return {
    configAllowFrom,
    hasWildcard,
    allowCount,
    isMultiUserDm: hasWildcard || allowCount > 1,
  };
}
