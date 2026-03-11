import type { MsgContext } from "../auto-reply/templating.js";
import { normalizeChatType } from "../channels/chat-type.js";

export function normalizeExplicitDiscordSessionKey(
  sessionKey: string,
  ctx: Pick<MsgContext, "ChatType" | "From" | "SenderId">,
): string {
  let normalized = sessionKey.trim().toLowerCase();
  if (normalizeChatType(ctx.ChatType) !== "direct") {
    return normalized;
  }

  normalized = normalized.replace(/^(discord:)dm:/, "$1direct:");
  normalized = normalized.replace(/^(agent:[^:]+:discord:)dm:/, "$1direct:");
  const match = normalized.match(/^((?:agent:[^:]+:)?)discord:channel:([^:]+)$/);
  if (!match) {
    return normalized;
  }

  const from = (ctx.From ?? "").trim().toLowerCase();
  const senderId = (ctx.SenderId ?? "").trim().toLowerCase();
  const fromDiscordId =
    from.startsWith("discord:") && !from.includes(":channel:") && !from.includes(":group:")
      ? from.slice("discord:".length)
      : "";
  const directId = senderId || fromDiscordId;
  return directId && directId === match[2] ? `${match[1]}discord:direct:${match[2]}` : normalized;
}
