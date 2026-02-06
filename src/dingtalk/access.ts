import type { AllowlistMatch } from "../channels/allowlist-match.js";

export type NormalizedAllowFrom = {
  entries: string[];
  entriesLower: string[];
  hasWildcard: boolean;
  hasEntries: boolean;
};

export type AllowFromMatch = AllowlistMatch<"wildcard" | "id">;

export const normalizeAllowFrom = (list?: Array<string | number>): NormalizedAllowFrom => {
  const entries = (list ?? []).map((value) => String(value).trim()).filter(Boolean);
  const hasWildcard = entries.includes("*");
  const normalized = entries
    .filter((value) => value !== "*")
    .map((value) => value.replace(/^(dingtalk|dingtalk-connector|dd|ding):/i, ""));
  const normalizedLower = normalized.map((value) => value.toLowerCase());
  return {
    entries: normalized,
    entriesLower: normalizedLower,
    hasWildcard,
    hasEntries: entries.length > 0,
  };
};

export const normalizeAllowFromWithStore = (params: {
  allowFrom?: Array<string | number>;
  storeAllowFrom?: string[];
}): NormalizedAllowFrom => {
  const combined = [...(params.allowFrom ?? []), ...(params.storeAllowFrom ?? [])]
    .map((value) => String(value).trim())
    .filter(Boolean);
  return normalizeAllowFrom(combined);
};

export const isSenderAllowed = (params: { allow: NormalizedAllowFrom; senderId?: string }) => {
  const { allow, senderId } = params;
  if (!allow.hasEntries || allow.hasWildcard) {
    return true;
  }
  if (senderId && allow.entries.includes(senderId)) {
    return true;
  }
  if (senderId && allow.entriesLower.includes(senderId.toLowerCase())) {
    return true;
  }
  return false;
};

export const resolveSenderAllowMatch = (params: {
  allow: NormalizedAllowFrom;
  senderId?: string;
}): AllowFromMatch => {
  const { allow, senderId } = params;
  if (allow.hasWildcard) {
    return { allowed: true, matchKey: "*", matchSource: "wildcard" };
  }
  if (!allow.hasEntries) {
    return { allowed: false };
  }
  if (senderId && allow.entries.includes(senderId)) {
    return { allowed: true, matchKey: senderId, matchSource: "id" };
  }
  if (senderId && allow.entriesLower.includes(senderId.toLowerCase())) {
    return { allowed: true, matchKey: senderId.toLowerCase(), matchSource: "id" };
  }
  return { allowed: false };
};
