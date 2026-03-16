import { parseTelegramTarget } from "../../../extensions/telegram/src/targets.js";
import type { ChatType } from "../../channels/chat-type.js";
import type { ChannelId } from "../../channels/plugins/types.js";
import { isWhatsAppGroupJid, normalizeWhatsAppTarget } from "../../whatsapp/normalize.js";

export type BuiltInExplicitTarget = {
  to: string;
  threadId?: string | number;
  chatType?: ChatType;
};

export function resolveBuiltInExplicitTarget(
  channel: ChannelId,
  raw: string,
): BuiltInExplicitTarget | null {
  if (channel === "telegram") {
    const target = parseTelegramTarget(raw);
    return {
      to: target.chatId,
      threadId: target.messageThreadId,
      chatType: target.chatType === "unknown" ? undefined : target.chatType,
    };
  }

  if (channel === "whatsapp") {
    const normalized = normalizeWhatsAppTarget(raw);
    if (!normalized) {
      return null;
    }
    return {
      to: normalized,
      chatType: isWhatsAppGroupJid(normalized) ? "group" : "direct",
    };
  }

  return null;
}

export function resolveBuiltInTargetChatType(channel: ChannelId, to: string): ChatType | undefined {
  return resolveBuiltInExplicitTarget(channel, to)?.chatType;
}
