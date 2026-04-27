import { type ChatChannelId } from "./ids.js";
import type { ChannelId } from "./plugins/channel-id.types.js";
export declare function normalizeChannelId(raw?: string | null): ChatChannelId | null;
export declare function normalizeAnyChannelId(raw?: string | null): ChannelId | null;
