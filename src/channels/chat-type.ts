import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";

export const CHAT_TYPES = ["direct", "group", "channel"] as const;

export type ChatType = (typeof CHAT_TYPES)[number];

const CHAT_TYPE_SET: ReadonlySet<string> = new Set(CHAT_TYPES);

export function isChatType(value: string | undefined): value is ChatType {
  return value !== undefined && CHAT_TYPE_SET.has(value);
}

export function normalizeChatType(raw?: string): ChatType | undefined {
  const value = normalizeOptionalLowercaseString(raw);
  if (!value) {
    return undefined;
  }
  if (value === "dm") {
    return "direct";
  }
  return isChatType(value) ? value : undefined;
}
