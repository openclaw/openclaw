export type NormalizedChatType = "direct" | "group" | "channel";

export function normalizeChatType(raw?: string): NormalizedChatType | undefined {
  const value = raw?.trim().toLowerCase();
  if (!value) return undefined;
  if (value === "direct" || value === "dm") return "direct";
  if (value === "group") return "group";
  if (value === "channel") return "channel";
  return undefined;
}
