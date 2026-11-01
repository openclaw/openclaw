import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";

export type ChatType = "direct" | "group" | "channel";

export function normalizeChatType(raw?: string): ChatType | undefined {
  const value = normalizeOptionalLowercaseString(raw);
  if (value === "dm") {
    return "direct";
  }
  return value === "direct" || value === "group" || value === "channel" ? value : undefined;
}
