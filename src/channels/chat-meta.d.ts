import { type ChatChannelMeta } from "./chat-meta-shared.js";
import { type ChatChannelId } from "./ids.js";
export type { ChatChannelMeta };
export declare function listChatChannels(): ChatChannelMeta[];
export declare function getChatChannelMeta(id: ChatChannelId): ChatChannelMeta;
