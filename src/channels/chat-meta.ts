import { buildChatChannelMetaById, type ChatChannelMeta } from "./chat-meta-shared.js";
import { CHAT_CHANNEL_ORDER, type ChatChannelId } from "./ids.js";

const CHAT_CHANNEL_META = buildChatChannelMetaById();

export type { ChatChannelMeta };

export function listChatChannels(): ChatChannelMeta[] {
  return CHAT_CHANNEL_ORDER.map((id) => CHAT_CHANNEL_META[id]);
}

export function getChatChannelMeta(id: ChatChannelId): ChatChannelMeta {
  return CHAT_CHANNEL_META[id];
}
