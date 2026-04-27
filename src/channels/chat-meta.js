import { buildChatChannelMetaById } from "./chat-meta-shared.js";
import { CHAT_CHANNEL_ORDER } from "./ids.js";
const CHAT_CHANNEL_META = buildChatChannelMetaById();
export function listChatChannels() {
    return CHAT_CHANNEL_ORDER.map((id) => CHAT_CHANNEL_META[id]);
}
export function getChatChannelMeta(id) {
    return CHAT_CHANNEL_META[id];
}
