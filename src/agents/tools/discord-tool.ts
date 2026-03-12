import { Type } from "@sinclair/typebox";
import { loadConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveDiscordChannelId } from "../../discord/targets.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { handleDiscordAction } from "./discord-actions.js";

const DiscordToolSchema = Type.Object({
  action: Type.String({
    description:
      "The Discord action to perform. Options: react, reactions, sticker, poll, permissions, fetchMessage, readMessages, sendMessage, editMessage, deleteMessage, threadCreate, threadList, threadReply, pinMessage, unpinMessage, listPins, searchMessages, memberInfo, roleInfo, emojiList, emojiUpload, stickerUpload, roleAdd, roleRemove, channelInfo, channelList, voiceStatus, eventList, eventCreate, channelCreate, channelEdit, channelDelete, channelMove, categoryCreate, categoryEdit, categoryDelete, channelPermissionSet, channelPermissionRemove, timeout, kick, ban, setPresence",
  }),
  channelId: Type.Optional(
    Type.String({
      description: "Discord channel ID (required for most messaging actions)",
    }),
  ),
  guildId: Type.Optional(
    Type.String({
      description: "Discord guild ID (required for some actions)",
    }),
  ),
  messageId: Type.Optional(
    Type.String({
      description: "Discord message ID (required for message-specific actions)",
    }),
  ),
  to: Type.Optional(
    Type.String({
      description: "Target channel or thread for sending messages",
    }),
  ),
  content: Type.Optional(
    Type.String({
      description: "Message content",
    }),
  ),
  // Additional parameters are passed through to the action handler
});

export function createDiscordTool(options?: {
  agentSessionKey?: string;
  config?: OpenClawConfig;
  agentChannel?: GatewayMessageChannel;
  agentAccountId?: string;
}): AnyAgentTool {
  const cfg = options?.config ?? loadConfig();

  return {
    label: "Discord",
    name: "discord",
    description:
      "Perform Discord actions: send/delete messages, react, manage channels, moderate users, and more. Specify the action and required parameters.",
    parameters: DiscordToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;

      if (!params.action || typeof params.action !== "string") {
        return jsonResult({
          ok: false,
          error:
            "The 'action' parameter is required. Examples: sendMessage, deleteMessage, react, readMessages",
        });
      }

      try {
        // Resolve channel ID if provided as a raw ID
        if (params.channelId && typeof params.channelId === "string") {
          try {
            params.channelId = resolveDiscordChannelId(params.channelId);
          } catch {
            // If resolution fails, pass through as-is and let the action handler validate
          }
        }

        const result = await handleDiscordAction(params, cfg, {
          mediaLocalRoots: undefined,
        });

        return result;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return jsonResult({
          ok: false,
          error: `Discord action failed: ${errorMessage}`,
        });
      }
    },
  };
}
