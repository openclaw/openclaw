export type ChatType = "direct" | "group" | "channel" | "private-channel";

export function normalizeChatType(raw?: string): ChatType | undefined {
  const value = raw?.trim().toLowerCase();
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
  if (value === "private-channel" || value === "private") {
    return "private-channel";
  }
  return undefined;
}
