import { mergeDmAllowFromSources, resolveGroupAllowFromSources } from "../channels/allow-from.js";
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

export function resolveDmGroupAccessDecision(params: {
  isGroup: boolean;
  dmPolicy?: string | null;
  groupPolicy?: string | null;
  effectiveAllowFrom: Array<string | number>;
  effectiveGroupAllowFrom: Array<string | number>;
  isSenderAllowed: (allowFrom: string[]) => boolean;
}): {
  decision: DmGroupAccessDecision;
  reason: string;
} {
  const dmPolicy = params.dmPolicy ?? "pairing";
  const groupPolicy = params.groupPolicy ?? "allowlist";
  const effectiveAllowFrom = normalizeStringEntries(params.effectiveAllowFrom);
  const effectiveGroupAllowFrom = normalizeStringEntries(params.effectiveGroupAllowFrom);

  if (params.isGroup) {
    if (groupPolicy === "disabled") {
      return { decision: "block", reason: "groupPolicy=disabled" };
    }
    if (groupPolicy === "allowlist") {
      if (effectiveGroupAllowFrom.length === 0) {
        return { decision: "block", reason: "groupPolicy=allowlist (empty allowlist)" };
      }
      if (!params.isSenderAllowed(effectiveGroupAllowFrom)) {
        return { decision: "block", reason: "groupPolicy=allowlist (not allowlisted)" };
      }
    }
    return { decision: "allow", reason: `groupPolicy=${groupPolicy}` };
  }

  if (dmPolicy === "disabled") {
    return { decision: "block", reason: "dmPolicy=disabled" };
  }
  if (dmPolicy === "open") {
    return { decision: "allow", reason: "dmPolicy=open" };
  }
  if (params.isSenderAllowed(effectiveAllowFrom)) {
    return { decision: "allow", reason: `dmPolicy=${dmPolicy} (allowlisted)` };
  }
  if (dmPolicy === "pairing") {
    return { decision: "pairing", reason: "dmPolicy=pairing (not allowlisted)" };
  }
  return { decision: "block", reason: `dmPolicy=${dmPolicy} (not allowlisted)` };
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

export async function resolveDmAllowState(params: {
  provider: ChannelId;
  allowFrom?: Array<string | number> | null;
  normalizeEntry?: (raw: string) => string;
  readStore?: (provider: ChannelId) => Promise<string[]>;
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
  const storeAllowFrom = await (params.readStore ?? readChannelAllowFromStore)(
    params.provider,
  ).catch(() => []);
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
