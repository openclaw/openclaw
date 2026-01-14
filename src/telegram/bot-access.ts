export type NormalizedAllowFrom = {
  entries: string[];
  entriesLower: string[];
  hasWildcard: boolean;
  hasEntries: boolean;
};

export const normalizeAllowFrom = (list?: Array<string | number>): NormalizedAllowFrom => {
  const entries = (list ?? []).map((value) => String(value).trim()).filter(Boolean);
  const hasWildcard = entries.includes("*");
  const normalized = entries
    .filter((value) => value !== "*")
    .map((value) => value.replace(/^(telegram|tg):/i, ""));
  const normalizedLower = normalized.map((value) => value.toLowerCase());
  return {
    entries: normalized,
    entriesLower: normalizedLower,
    hasWildcard,
    hasEntries: entries.length > 0,
  };
};

export const firstDefined = <T>(...values: Array<T | undefined>) => {
  for (const value of values) {
    if (typeof value !== "undefined") return value;
  }
  return undefined;
};

export const isSenderAllowed = (params: {
  allow: NormalizedAllowFrom;
  senderId?: string;
  senderUsername?: string;
}) => {
  const { allow, senderId, senderUsername } = params;
  if (!allow.hasEntries) return true;
  if (allow.hasWildcard) return true;
  if (senderId && allow.entries.includes(senderId)) return true;
  const username = senderUsername?.toLowerCase();
  if (!username) return false;
  return allow.entriesLower.some((entry) => entry === username || entry === `@${username}`);
};
