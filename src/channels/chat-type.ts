import { normalizeOptionalString } from "../shared/string-coerce.js";

export type ChatType = "direct" | "group" | "channel";

export function normalizeChatType(raw?: string): ChatType | undefined {
  const value = normalizeOptionalString(raw)?.toLowerCase();
  if (!value) {
    return undefined;
  }
  if (value === "direct" || value === "dm") {
    return "direct";
  }
  if (value === "group") {
    return "group";
  }
  if (value === "channel") {
    return "channel";
  }
  return undefined;
}
