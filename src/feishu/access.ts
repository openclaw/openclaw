import type { AllowlistMatch } from "../channels/allowlist-match.js";

export type NormalizedAllowFrom = {
  entries: string[];
  entriesLower: string[];
  hasWildcard: boolean;
  hasEntries: boolean;
};

export type AllowFromMatch = AllowlistMatch<"wildcard" | "id">;

/**
 * Normalize an allowlist for Feishu.
 * Feishu IDs are open_id (ou_xxx) or union_id (on_xxx), no usernames.
 */
export const normalizeAllowFrom = (list?: Array<string | number>): NormalizedAllowFrom => {
  const entries = (list ?? []).map((value) => String(value).trim()).filter(Boolean);
  const hasWildcard = entries.includes("*");
  // Strip optional "feishu:" prefix
  const normalized = entries
    .filter((value) => value !== "*")
    .map((value) => value.replace(/^(feishu|lark):/i, ""));
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

export const firstDefined = <T>(...values: Array<T | undefined>) => {
  for (const value of values) {
    if (typeof value !== "undefined") {
      return value;
    }
  }
  return undefined;
};

/**
 * Check if a sender is allowed based on the normalized allowlist.
 * Feishu uses open_id (ou_xxx) or union_id (on_xxx) - no usernames.
 */
export const isSenderAllowed = (params: { allow: NormalizedAllowFrom; senderId?: string }) => {
  const { allow, senderId } = params;
  if (!allow.hasEntries) {
    return true;
  }
  if (allow.hasWildcard) {
    return true;
  }
  if (senderId && allow.entries.includes(senderId)) {
    return true;
  }
  // Also check case-insensitive (though Feishu IDs are typically lowercase)
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
