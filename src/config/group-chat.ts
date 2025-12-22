import type { ClawdisConfig, GroupChatActivationMode } from "./config.js";

export function resolveGroupChatActivation(
  cfg?: ClawdisConfig,
): GroupChatActivationMode {
  const groupChat = cfg?.inbound?.groupChat;
  if (groupChat?.activation === "always") return "always";
  if (groupChat?.activation === "mention") return "mention";
  if (groupChat?.requireMention === false) return "always";
  return "mention";
}
