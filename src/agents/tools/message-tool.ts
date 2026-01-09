import { Type } from "@sinclair/typebox";

import type { ClawdbotConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import {
  type MessagePollResult,
  type MessageSendResult,
  sendMessage,
  sendPoll,
} from "../../infra/outbound/message.js";
import { resolveMessageProviderSelection } from "../../infra/outbound/provider-selection.js";
import { normalizeAccountId } from "../../routing/session-key.js";
import type { AnyAgentTool } from "./common.js";
import {
  jsonResult,
  readNumberParam,
  readStringArrayParam,
  readStringParam,
} from "./common.js";
import { handleDiscordAction } from "./discord-actions.js";
import { handleSlackAction } from "./slack-actions.js";
import { handleTelegramAction } from "./telegram-actions.js";
import { handleWhatsAppAction } from "./whatsapp-actions.js";

const MessageActionSchema = Type.Union([
  Type.Literal("send"),
  Type.Literal("poll"),
  Type.Literal("react"),
  Type.Literal("reactions"),
  Type.Literal("read"),
  Type.Literal("edit"),
  Type.Literal("delete"),
  Type.Literal("pin"),
  Type.Literal("unpin"),
  Type.Literal("list-pins"),
  Type.Literal("permissions"),
  Type.Literal("thread-create"),
  Type.Literal("thread-list"),
  Type.Literal("thread-reply"),
  Type.Literal("search"),
  Type.Literal("sticker"),
  Type.Literal("member-info"),
  Type.Literal("role-info"),
  Type.Literal("emoji-list"),
  Type.Literal("emoji-upload"),
  Type.Literal("sticker-upload"),
  Type.Literal("role-add"),
  Type.Literal("role-remove"),
  Type.Literal("channel-info"),
  Type.Literal("channel-list"),
  Type.Literal("voice-status"),
  Type.Literal("event-list"),
  Type.Literal("event-create"),
  Type.Literal("timeout"),
  Type.Literal("kick"),
  Type.Literal("ban"),
]);

const MessageToolSchema = Type.Object({
  action: MessageActionSchema,
  provider: Type.Optional(Type.String()),
  to: Type.Optional(Type.String()),
  message: Type.Optional(Type.String()),
  media: Type.Optional(Type.String()),
  messageId: Type.Optional(Type.String()),
  replyTo: Type.Optional(Type.String()),
  threadId: Type.Optional(Type.String()),
  accountId: Type.Optional(Type.String()),
  dryRun: Type.Optional(Type.Boolean()),
  bestEffort: Type.Optional(Type.Boolean()),
  gifPlayback: Type.Optional(Type.Boolean()),
  emoji: Type.Optional(Type.String()),
  remove: Type.Optional(Type.Boolean()),
  limit: Type.Optional(Type.Number()),
  before: Type.Optional(Type.String()),
  after: Type.Optional(Type.String()),
  around: Type.Optional(Type.String()),
  pollQuestion: Type.Optional(Type.String()),
  pollOption: Type.Optional(Type.Array(Type.String())),
  pollDurationHours: Type.Optional(Type.Number()),
  pollMulti: Type.Optional(Type.Boolean()),
  channelId: Type.Optional(Type.String()),
  channelIds: Type.Optional(Type.Array(Type.String())),
  guildId: Type.Optional(Type.String()),
  userId: Type.Optional(Type.String()),
  authorId: Type.Optional(Type.String()),
  authorIds: Type.Optional(Type.Array(Type.String())),
  roleId: Type.Optional(Type.String()),
  roleIds: Type.Optional(Type.Array(Type.String())),
  emojiName: Type.Optional(Type.String()),
  stickerId: Type.Optional(Type.Array(Type.String())),
  stickerName: Type.Optional(Type.String()),
  stickerDesc: Type.Optional(Type.String()),
  stickerTags: Type.Optional(Type.String()),
  threadName: Type.Optional(Type.String()),
  autoArchiveMin: Type.Optional(Type.Number()),
  query: Type.Optional(Type.String()),
  eventName: Type.Optional(Type.String()),
  eventType: Type.Optional(Type.String()),
  startTime: Type.Optional(Type.String()),
  endTime: Type.Optional(Type.String()),
  desc: Type.Optional(Type.String()),
  location: Type.Optional(Type.String()),
  durationMin: Type.Optional(Type.Number()),
  until: Type.Optional(Type.String()),
  reason: Type.Optional(Type.String()),
  deleteDays: Type.Optional(Type.Number()),
  includeArchived: Type.Optional(Type.Boolean()),
  participant: Type.Optional(Type.String()),
  fromMe: Type.Optional(Type.Boolean()),
  gatewayUrl: Type.Optional(Type.String()),
  gatewayToken: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),
});

type MessageToolOptions = {
  agentAccountId?: string;
  config?: ClawdbotConfig;
};

function resolveAgentAccountId(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return normalizeAccountId(trimmed);
}

export function createMessageTool(options?: MessageToolOptions): AnyAgentTool {
  const agentAccountId = resolveAgentAccountId(options?.agentAccountId);
  return {
    label: "Message",
    name: "message",
    description:
      "Send messages and provider-specific actions (Discord/Slack/Telegram/WhatsApp/Signal/iMessage/MS Teams).",
    parameters: MessageToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const cfg = options?.config ?? loadConfig();
      const action = readStringParam(params, "action", { required: true });
      const providerSelection = await resolveMessageProviderSelection({
        cfg,
        provider: readStringParam(params, "provider"),
      });
      const provider = providerSelection.provider;
      const accountId = readStringParam(params, "accountId") ?? agentAccountId;
      const gateway = {
        url: readStringParam(params, "gatewayUrl", { trim: false }),
        token: readStringParam(params, "gatewayToken", { trim: false }),
        timeoutMs: readNumberParam(params, "timeoutMs"),
        clientName: "agent" as const,
        mode: "agent" as const,
      };
      const dryRun = Boolean(params.dryRun);

      if (action === "send") {
        const to = readStringParam(params, "to", { required: true });
        const message = readStringParam(params, "message", {
          required: true,
          allowEmpty: true,
        });
        const mediaUrl = readStringParam(params, "media", { trim: false });
        const replyTo = readStringParam(params, "replyTo");
        const threadId = readStringParam(params, "threadId");
        const gifPlayback =
          typeof params.gifPlayback === "boolean" ? params.gifPlayback : false;
        const bestEffort =
          typeof params.bestEffort === "boolean"
            ? params.bestEffort
            : undefined;

        if (dryRun) {
          const result: MessageSendResult = await sendMessage({
            to,
            content: message,
            mediaUrl: mediaUrl || undefined,
            provider: provider || undefined,
            accountId: accountId ?? undefined,
            gifPlayback,
            dryRun,
            bestEffort,
            gateway,
          });
          return jsonResult(result);
        }

        if (provider === "discord") {
          return await handleDiscordAction(
            {
              action: "sendMessage",
              to,
              content: message,
              mediaUrl: mediaUrl ?? undefined,
              replyTo: replyTo ?? undefined,
            },
            cfg,
          );
        }
        if (provider === "slack") {
          return await handleSlackAction(
            {
              action: "sendMessage",
              to,
              content: message,
              mediaUrl: mediaUrl ?? undefined,
              accountId: accountId ?? undefined,
              threadTs: threadId ?? replyTo ?? undefined,
            },
            cfg,
          );
        }
        if (provider === "telegram") {
          return await handleTelegramAction(
            {
              action: "sendMessage",
              to,
              content: message,
              mediaUrl: mediaUrl ?? undefined,
              replyToMessageId: replyTo ?? undefined,
              messageThreadId: threadId ?? undefined,
            },
            cfg,
          );
        }

        const result: MessageSendResult = await sendMessage({
          to,
          content: message,
          mediaUrl: mediaUrl || undefined,
          provider: provider || undefined,
          accountId: accountId ?? undefined,
          gifPlayback,
          dryRun,
          bestEffort,
          gateway,
        });
        return jsonResult(result);
      }

      if (action === "poll") {
        const to = readStringParam(params, "to", { required: true });
        const question = readStringParam(params, "pollQuestion", {
          required: true,
        });
        const options =
          readStringArrayParam(params, "pollOption", { required: true }) ?? [];
        const allowMultiselect =
          typeof params.pollMulti === "boolean" ? params.pollMulti : undefined;
        const durationHours = readNumberParam(params, "pollDurationHours", {
          integer: true,
        });

        if (dryRun) {
          const maxSelections = allowMultiselect
            ? Math.max(2, options.length)
            : 1;
          const result: MessagePollResult = await sendPoll({
            to,
            question,
            options,
            maxSelections,
            durationHours: durationHours ?? undefined,
            provider,
            dryRun,
            gateway,
          });
          return jsonResult(result);
        }

        if (provider === "discord") {
          return await handleDiscordAction(
            {
              action: "poll",
              to,
              question,
              answers: options,
              allowMultiselect,
              durationHours: durationHours ?? undefined,
              content: readStringParam(params, "message"),
            },
            cfg,
          );
        }

        const maxSelections = allowMultiselect
          ? Math.max(2, options.length)
          : 1;
        const result: MessagePollResult = await sendPoll({
          to,
          question,
          options,
          maxSelections,
          durationHours: durationHours ?? undefined,
          provider,
          dryRun,
          gateway,
        });
        return jsonResult(result);
      }

      const resolveChannelId = (label: string) =>
        readStringParam(params, label) ??
        readStringParam(params, "to", { required: true });

      const resolveChatId = (label: string) =>
        readStringParam(params, label) ??
        readStringParam(params, "to", { required: true });

      if (action === "react") {
        const messageId = readStringParam(params, "messageId", {
          required: true,
        });
        const emoji = readStringParam(params, "emoji", { allowEmpty: true });
        const remove =
          typeof params.remove === "boolean" ? params.remove : undefined;
        if (provider === "discord") {
          return await handleDiscordAction(
            {
              action: "react",
              channelId: resolveChannelId("channelId"),
              messageId,
              emoji,
              remove,
            },
            cfg,
          );
        }
        if (provider === "slack") {
          return await handleSlackAction(
            {
              action: "react",
              channelId: resolveChannelId("channelId"),
              messageId,
              emoji,
              remove,
              accountId: accountId ?? undefined,
            },
            cfg,
          );
        }
        if (provider === "telegram") {
          return await handleTelegramAction(
            {
              action: "react",
              chatId: resolveChatId("chatId"),
              messageId,
              emoji,
              remove,
            },
            cfg,
          );
        }
        if (provider === "whatsapp") {
          return await handleWhatsAppAction(
            {
              action: "react",
              chatJid: resolveChatId("chatJid"),
              messageId,
              emoji,
              remove,
              participant: readStringParam(params, "participant"),
              accountId: accountId ?? undefined,
              fromMe:
                typeof params.fromMe === "boolean" ? params.fromMe : undefined,
            },
            cfg,
          );
        }
        throw new Error(`React is not supported for provider ${provider}.`);
      }

      if (action === "reactions") {
        const messageId = readStringParam(params, "messageId", {
          required: true,
        });
        const limit = readNumberParam(params, "limit", { integer: true });
        if (provider === "discord") {
          return await handleDiscordAction(
            {
              action: "reactions",
              channelId: resolveChannelId("channelId"),
              messageId,
              limit,
            },
            cfg,
          );
        }
        if (provider === "slack") {
          return await handleSlackAction(
            {
              action: "reactions",
              channelId: resolveChannelId("channelId"),
              messageId,
              limit,
              accountId: accountId ?? undefined,
            },
            cfg,
          );
        }
        throw new Error(
          `Reactions are not supported for provider ${provider}.`,
        );
      }

      if (action === "read") {
        const limit = readNumberParam(params, "limit", { integer: true });
        const before = readStringParam(params, "before");
        const after = readStringParam(params, "after");
        const around = readStringParam(params, "around");
        if (provider === "discord") {
          return await handleDiscordAction(
            {
              action: "readMessages",
              channelId: resolveChannelId("channelId"),
              limit,
              before,
              after,
              around,
            },
            cfg,
          );
        }
        if (provider === "slack") {
          return await handleSlackAction(
            {
              action: "readMessages",
              channelId: resolveChannelId("channelId"),
              limit,
              before,
              after,
              accountId: accountId ?? undefined,
            },
            cfg,
          );
        }
        throw new Error(`Read is not supported for provider ${provider}.`);
      }

      if (action === "edit") {
        const messageId = readStringParam(params, "messageId", {
          required: true,
        });
        const message = readStringParam(params, "message", { required: true });
        if (provider === "discord") {
          return await handleDiscordAction(
            {
              action: "editMessage",
              channelId: resolveChannelId("channelId"),
              messageId,
              content: message,
            },
            cfg,
          );
        }
        if (provider === "slack") {
          return await handleSlackAction(
            {
              action: "editMessage",
              channelId: resolveChannelId("channelId"),
              messageId,
              content: message,
              accountId: accountId ?? undefined,
            },
            cfg,
          );
        }
        throw new Error(`Edit is not supported for provider ${provider}.`);
      }

      if (action === "delete") {
        const messageId = readStringParam(params, "messageId", {
          required: true,
        });
        if (provider === "discord") {
          return await handleDiscordAction(
            {
              action: "deleteMessage",
              channelId: resolveChannelId("channelId"),
              messageId,
            },
            cfg,
          );
        }
        if (provider === "slack") {
          return await handleSlackAction(
            {
              action: "deleteMessage",
              channelId: resolveChannelId("channelId"),
              messageId,
              accountId: accountId ?? undefined,
            },
            cfg,
          );
        }
        throw new Error(`Delete is not supported for provider ${provider}.`);
      }

      if (action === "pin" || action === "unpin" || action === "list-pins") {
        const messageId =
          action === "list-pins"
            ? undefined
            : readStringParam(params, "messageId", { required: true });
        const channelId = resolveChannelId("channelId");
        if (provider === "discord") {
          const discordAction =
            action === "pin"
              ? "pinMessage"
              : action === "unpin"
                ? "unpinMessage"
                : "listPins";
          return await handleDiscordAction(
            {
              action: discordAction,
              channelId,
              messageId,
            },
            cfg,
          );
        }
        if (provider === "slack") {
          const slackAction =
            action === "pin"
              ? "pinMessage"
              : action === "unpin"
                ? "unpinMessage"
                : "listPins";
          return await handleSlackAction(
            {
              action: slackAction,
              channelId,
              messageId,
              accountId: accountId ?? undefined,
            },
            cfg,
          );
        }
        throw new Error(`Pins are not supported for provider ${provider}.`);
      }

      if (action === "permissions") {
        if (provider !== "discord") {
          throw new Error(
            `Permissions are only supported for Discord (provider=${provider}).`,
          );
        }
        return await handleDiscordAction(
          {
            action: "permissions",
            channelId: resolveChannelId("channelId"),
          },
          cfg,
        );
      }

      if (action === "thread-create") {
        if (provider !== "discord") {
          throw new Error(
            `Thread create is only supported for Discord (provider=${provider}).`,
          );
        }
        const name = readStringParam(params, "threadName", { required: true });
        const messageId = readStringParam(params, "messageId");
        const autoArchiveMinutes = readNumberParam(params, "autoArchiveMin", {
          integer: true,
        });
        return await handleDiscordAction(
          {
            action: "threadCreate",
            channelId: resolveChannelId("channelId"),
            name,
            messageId,
            autoArchiveMinutes,
          },
          cfg,
        );
      }

      if (action === "thread-list") {
        if (provider !== "discord") {
          throw new Error(
            `Thread list is only supported for Discord (provider=${provider}).`,
          );
        }
        const guildId = readStringParam(params, "guildId", { required: true });
        const channelId = readStringParam(params, "channelId");
        const includeArchived =
          typeof params.includeArchived === "boolean"
            ? params.includeArchived
            : undefined;
        const before = readStringParam(params, "before");
        const limit = readNumberParam(params, "limit", { integer: true });
        return await handleDiscordAction(
          {
            action: "threadList",
            guildId,
            channelId,
            includeArchived,
            before,
            limit,
          },
          cfg,
        );
      }

      if (action === "thread-reply") {
        if (provider !== "discord") {
          throw new Error(
            `Thread reply is only supported for Discord (provider=${provider}).`,
          );
        }
        const content = readStringParam(params, "message", { required: true });
        const mediaUrl = readStringParam(params, "media", { trim: false });
        const replyTo = readStringParam(params, "replyTo");
        return await handleDiscordAction(
          {
            action: "threadReply",
            channelId: resolveChannelId("channelId"),
            content,
            mediaUrl: mediaUrl ?? undefined,
            replyTo: replyTo ?? undefined,
          },
          cfg,
        );
      }

      if (action === "search") {
        if (provider !== "discord") {
          throw new Error(
            `Search is only supported for Discord (provider=${provider}).`,
          );
        }
        const guildId = readStringParam(params, "guildId", { required: true });
        const query = readStringParam(params, "query", { required: true });
        const channelId = readStringParam(params, "channelId");
        const channelIds = readStringArrayParam(params, "channelIds");
        const authorId = readStringParam(params, "authorId");
        const authorIds = readStringArrayParam(params, "authorIds");
        const limit = readNumberParam(params, "limit", { integer: true });
        return await handleDiscordAction(
          {
            action: "searchMessages",
            guildId,
            content: query,
            channelId,
            channelIds,
            authorId,
            authorIds,
            limit,
          },
          cfg,
        );
      }

      if (action === "sticker") {
        if (provider !== "discord") {
          throw new Error(
            `Sticker send is only supported for Discord (provider=${provider}).`,
          );
        }
        const stickerIds =
          readStringArrayParam(params, "stickerId", {
            required: true,
            label: "sticker-id",
          }) ?? [];
        const content = readStringParam(params, "message");
        return await handleDiscordAction(
          {
            action: "sticker",
            to: readStringParam(params, "to", { required: true }),
            stickerIds,
            content,
          },
          cfg,
        );
      }

      if (action === "member-info") {
        const userId = readStringParam(params, "userId", { required: true });
        if (provider === "discord") {
          const guildId = readStringParam(params, "guildId", {
            required: true,
          });
          return await handleDiscordAction(
            { action: "memberInfo", guildId, userId },
            cfg,
          );
        }
        if (provider === "slack") {
          return await handleSlackAction(
            { action: "memberInfo", userId, accountId: accountId ?? undefined },
            cfg,
          );
        }
        throw new Error(
          `Member info is not supported for provider ${provider}.`,
        );
      }

      if (action === "role-info") {
        if (provider !== "discord") {
          throw new Error(
            `Role info is only supported for Discord (provider=${provider}).`,
          );
        }
        const guildId = readStringParam(params, "guildId", { required: true });
        return await handleDiscordAction({ action: "roleInfo", guildId }, cfg);
      }

      if (action === "emoji-list") {
        if (provider === "discord") {
          const guildId = readStringParam(params, "guildId", {
            required: true,
          });
          return await handleDiscordAction(
            { action: "emojiList", guildId },
            cfg,
          );
        }
        if (provider === "slack") {
          return await handleSlackAction(
            { action: "emojiList", accountId: accountId ?? undefined },
            cfg,
          );
        }
        throw new Error(
          `Emoji list is not supported for provider ${provider}.`,
        );
      }

      if (action === "emoji-upload") {
        if (provider !== "discord") {
          throw new Error(
            `Emoji upload is only supported for Discord (provider=${provider}).`,
          );
        }
        const guildId = readStringParam(params, "guildId", { required: true });
        const name = readStringParam(params, "emojiName", { required: true });
        const mediaUrl = readStringParam(params, "media", {
          required: true,
          trim: false,
        });
        const roleIds = readStringArrayParam(params, "roleIds");
        return await handleDiscordAction(
          {
            action: "emojiUpload",
            guildId,
            name,
            mediaUrl,
            roleIds,
          },
          cfg,
        );
      }

      if (action === "sticker-upload") {
        if (provider !== "discord") {
          throw new Error(
            `Sticker upload is only supported for Discord (provider=${provider}).`,
          );
        }
        const guildId = readStringParam(params, "guildId", { required: true });
        const name = readStringParam(params, "stickerName", { required: true });
        const description = readStringParam(params, "stickerDesc", {
          required: true,
        });
        const tags = readStringParam(params, "stickerTags", { required: true });
        const mediaUrl = readStringParam(params, "media", {
          required: true,
          trim: false,
        });
        return await handleDiscordAction(
          {
            action: "stickerUpload",
            guildId,
            name,
            description,
            tags,
            mediaUrl,
          },
          cfg,
        );
      }

      if (action === "role-add" || action === "role-remove") {
        if (provider !== "discord") {
          throw new Error(
            `Role changes are only supported for Discord (provider=${provider}).`,
          );
        }
        const guildId = readStringParam(params, "guildId", { required: true });
        const userId = readStringParam(params, "userId", { required: true });
        const roleId = readStringParam(params, "roleId", { required: true });
        const discordAction = action === "role-add" ? "roleAdd" : "roleRemove";
        return await handleDiscordAction(
          { action: discordAction, guildId, userId, roleId },
          cfg,
        );
      }

      if (action === "channel-info") {
        if (provider !== "discord") {
          throw new Error(
            `Channel info is only supported for Discord (provider=${provider}).`,
          );
        }
        const channelId = readStringParam(params, "channelId", {
          required: true,
        });
        return await handleDiscordAction(
          { action: "channelInfo", channelId },
          cfg,
        );
      }

      if (action === "channel-list") {
        if (provider !== "discord") {
          throw new Error(
            `Channel list is only supported for Discord (provider=${provider}).`,
          );
        }
        const guildId = readStringParam(params, "guildId", { required: true });
        return await handleDiscordAction(
          { action: "channelList", guildId },
          cfg,
        );
      }

      if (action === "voice-status") {
        if (provider !== "discord") {
          throw new Error(
            `Voice status is only supported for Discord (provider=${provider}).`,
          );
        }
        const guildId = readStringParam(params, "guildId", { required: true });
        const userId = readStringParam(params, "userId", { required: true });
        return await handleDiscordAction(
          { action: "voiceStatus", guildId, userId },
          cfg,
        );
      }

      if (action === "event-list") {
        if (provider !== "discord") {
          throw new Error(
            `Event list is only supported for Discord (provider=${provider}).`,
          );
        }
        const guildId = readStringParam(params, "guildId", { required: true });
        return await handleDiscordAction({ action: "eventList", guildId }, cfg);
      }

      if (action === "event-create") {
        if (provider !== "discord") {
          throw new Error(
            `Event create is only supported for Discord (provider=${provider}).`,
          );
        }
        const guildId = readStringParam(params, "guildId", { required: true });
        const name = readStringParam(params, "eventName", { required: true });
        const startTime = readStringParam(params, "startTime", {
          required: true,
        });
        const endTime = readStringParam(params, "endTime");
        const description = readStringParam(params, "desc");
        const channelId = readStringParam(params, "channelId");
        const location = readStringParam(params, "location");
        const entityType = readStringParam(params, "eventType");
        return await handleDiscordAction(
          {
            action: "eventCreate",
            guildId,
            name,
            startTime,
            endTime,
            description,
            channelId,
            location,
            entityType,
          },
          cfg,
        );
      }

      if (action === "timeout" || action === "kick" || action === "ban") {
        if (provider !== "discord") {
          throw new Error(
            `Moderation actions are only supported for Discord (provider=${provider}).`,
          );
        }
        const guildId = readStringParam(params, "guildId", { required: true });
        const userId = readStringParam(params, "userId", { required: true });
        const durationMinutes = readNumberParam(params, "durationMin", {
          integer: true,
        });
        const until = readStringParam(params, "until");
        const reason = readStringParam(params, "reason");
        const deleteMessageDays = readNumberParam(params, "deleteDays", {
          integer: true,
        });
        const discordAction = action as "timeout" | "kick" | "ban";
        return await handleDiscordAction(
          {
            action: discordAction,
            guildId,
            userId,
            durationMinutes,
            until,
            reason,
            deleteMessageDays,
          },
          cfg,
        );
      }

      throw new Error(`Unknown action: ${action}`);
    },
  };
}
