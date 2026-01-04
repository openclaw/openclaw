import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type {
  ClawdisConfig,
  DiscordActionConfig,
} from "../../config/config.js";
import { readStringParam } from "./common.js";
import { handleDiscordGuildAction } from "./discord-actions-guild.js";
import { handleDiscordMessagingAction } from "./discord-actions-messaging.js";
import { handleDiscordModerationAction } from "./discord-actions-moderation.js";

const messagingActions = new Set([
  "react",
  "reactions",
  "sticker",
  "poll",
  "permissions",
  "readMessages",
  "sendMessage",
  "editMessage",
  "deleteMessage",
  "threadCreate",
  "threadList",
  "threadReply",
  "pinMessage",
  "unpinMessage",
  "listPins",
  "searchMessages",
]);

const guildActions = new Set([
  "memberInfo",
  "roleInfo",
  "emojiList",
  "emojiUpload",
  "stickerUpload",
  "roleAdd",
  "roleRemove",
  "channelInfo",
  "channelList",
  "voiceStatus",
  "eventList",
  "eventCreate",
]);

const moderationActions = new Set(["timeout", "kick", "ban"]);

type ActionGate = (
  key: keyof DiscordActionConfig,
  defaultValue?: boolean,
) => boolean;

export async function handleDiscordAction(
  params: Record<string, unknown>,
  cfg: ClawdisConfig,
): Promise<AgentToolResult<unknown>> {
  const action = readStringParam(params, "action", { required: true });
  const isActionEnabled: ActionGate = (key, defaultValue = true) => {
    const value = cfg.discord?.actions?.[key];
    if (value === undefined) return defaultValue;
    return value !== false;
  };

  if (messagingActions.has(action)) {
    return await handleDiscordMessagingAction(action, params, isActionEnabled);
  }
  if (guildActions.has(action)) {
    return await handleDiscordGuildAction(action, params, isActionEnabled);
  }
  if (moderationActions.has(action)) {
    return await handleDiscordModerationAction(action, params, isActionEnabled);
  }
  throw new Error(`Unknown action: ${action}`);
}
