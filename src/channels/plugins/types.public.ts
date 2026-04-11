import {
  CHANNEL_MESSAGE_ACTION_NAMES,
  type ChannelMessageActionName as ChannelMessageActionNameFromList,
} from "./message-action-names.js";

export type * from "./types.core.js";
export type * from "./types.adapters.js";
export type { ChannelMessageCapability } from "./message-capabilities.js";
export { CHANNEL_MESSAGE_ACTION_NAMES };
export type { ChannelPlugin } from "./types.plugin.js";

export type ChannelMessageActionName = ChannelMessageActionNameFromList;
