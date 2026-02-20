import { firstDefined, isSenderIdAllowed, mergeAllowFromSources } from "../channels/allow-from.js";
import type { AllowlistMatch } from "../channels/allowlist-match.js";

export type NormalizedAllowFrom = {
  entries: string[];
  hasWildcard: boolean;
  hasEntries: boolean;
  invalidEntries: string[];
};

export type AllowFromMatch = AllowlistMatch<"wildcard" | "id">;

const warnedInvalidEntries = new Set<string>();

function warnInvalidAllowFromEntries(entries: string[]) {
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return;
  }
  for (const entry of entries) {
    if (warnedInvalidEntries.has(entry)) {
      continue;
    }
    warnedInvalidEntries.add(entry);
    console.warn(
      [
        "[telegram] Invalid allowFrom entry:",
        JSON.stringify(entry),
        "- allowFrom/groupAllowFrom authorization requires numeric Telegram sender IDs only.",
        'If you had "@username" entries, re-run onboarding (it resolves @username to IDs) or replace them manually.',
      ].join(" "),
    );
  }
}

export const normalizeAllowFrom = (list?: Array<string | number>): NormalizedAllowFrom => {
  const entries = (list ?? []).map((value) => String(value).trim()).filter(Boolean);
  const hasWildcard = entries.includes("*");
  const normalized = entries
    .filter((value) => value !== "*")
    .map((value) => value.replace(/^(telegram|tg):/i, ""));
  const invalidEntries = normalized.filter((value) => !/^\d+$/.test(value));
  if (invalidEntries.length > 0) {
    warnInvalidAllowFromEntries([...new Set(invalidEntries)]);
  }
  const ids = normalized.filter((value) => /^\d+$/.test(value));
  return {
    entries: ids,
    hasWildcard,
    hasEntries: entries.length > 0,
    invalidEntries,
  };
};

export const normalizeAllowFromWithStore = (params: {
  allowFrom?: Array<string | number>;
  storeAllowFrom?: string[];
}): NormalizedAllowFrom => normalizeAllowFrom(mergeAllowFromSources(params));

export const isSenderAllowed = (params: {
  allow: NormalizedAllowFrom;
  senderId?: string;
  senderUsername?: string;
}) => {
  const { allow, senderId } = params;
  return isSenderIdAllowed(allow, senderId, true);
};

export { firstDefined };

export const resolveSenderAllowMatch = (params: {
  allow: NormalizedAllowFrom;
  senderId?: string;
  senderUsername?: string;
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
  return { allowed: false };
};
