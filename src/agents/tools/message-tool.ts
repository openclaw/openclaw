import { Type } from "@sinclair/typebox";

import { parseReplyDirectives } from "../../auto-reply/reply/reply-directives.js";
import type { ClawdbotConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import { listEnabledDiscordAccounts } from "../../discord/accounts.js";
import {
  type MessagePollResult,
  type MessageSendResult,
  sendMessage,
  sendPoll,
} from "../../infra/outbound/message.js";
import { resolveMessageProviderSelection } from "../../infra/outbound/provider-selection.js";
import { resolveMSTeamsCredentials } from "../../msteams/token.js";
import { normalizeAccountId } from "../../routing/session-key.js";
import { listEnabledSlackAccounts } from "../../slack/accounts.js";
import { listEnabledTelegramAccounts } from "../../telegram/accounts.js";
import type { AnyAgentTool } from "./common.js";
import {
  createActionGate,
  jsonResult,
  readNumberParam,
  readStringArrayParam,
  readStringParam,
} from "./common.js";
import { handleDiscordAction } from "./discord-actions.js";
import { handleSlackAction } from "./slack-actions.js";
import { handleTelegramAction } from "./telegram-actions.js";
import { handleWhatsAppAction } from "./whatsapp-actions.js";

const AllMessageActions = [
  "send",
  "poll",
  "react",
  "reactions",
  "read",
  "edit",
  "delete",
  "pin",
  "unpin",
  "list-pins",
  "permissions",
  "thread-create",
  "thread-list",
  "thread-reply",
  "search",
  "sticker",
  "member-info",
  "role-info",
  "emoji-list",
  "emoji-upload",
  "sticker-upload",
  "role-add",
  "role-remove",
  "channel-info",
  "channel-list",
  "voice-status",
  "event-list",
  "event-create",
  "timeout",
  "kick",
  "ban",
];


const MessageToolCommonSchema = {
  provider: Type.Optional(Type.String()),
  media: Type.Optional(Type.String()),
  buttons: Type.Optional(
    Type.Array(
      Type.Array(
        Type.Object({
          text: Type.String(),
          callback_data: Type.String(),
        }),
      ),
      {
        description: "Telegram inline keyboard buttons (array of button rows)",
      },
    ),
  ),
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
};

function buildMessageToolSchemaFromActions(
  actions: string[],
  options: { includeButtons: boolean },
) {
  const props: Record<string, unknown> = { ...MessageToolCommonSchema };
  if (!options.includeButtons) delete props.buttons;

  const schemas: Array<ReturnType<typeof Type.Object>> = [];
  if (actions.includes("send")) {
    schemas.push(
      Type.Object({
        action: Type.Literal("send"),
        to: Type.String(),
        message: Type.String(),
        ...props,
      }),
    );
  }

  const nonSendActions = actions.filter((action) => action !== "send");
  if (nonSendActions.length > 0) {
    schemas.push(
      Type.Object({
        action: Type.Union(
          nonSendActions.map((action) => Type.Literal(action)),
        ),
        to: Type.Optional(Type.String()),
        message: Type.Optional(Type.String()),
        ...props,
      }),
    );
  }

  return schemas.length === 1 ? schemas[0] : Type.Union(schemas);
}

const MessageToolSchema = buildMessageToolSchemaFromActions(AllMessageActions, {
  includeButtons: true,
});

type MessageToolOptions = {
  agentAccountId?: string;
  config?: ClawdbotConfig;
  /** Current channel ID for auto-threading (Slack). */
  currentChannelId?: string;
  /** Current thread timestamp for auto-threading (Slack). */
  currentThreadTs?: string;
  /** Reply-to mode for Slack auto-threading. */
  replyToMode?: "off" | "first" | "all";
  /** Mutable ref to track if a reply was sent (for "first" mode). */
  hasRepliedRef?: { value: boolean };
};

function hasTelegramInlineButtons(cfg: ClawdbotConfig): boolean {
  const caps = new Set<string>();
  for (const entry of cfg.telegram?.capabilities ?? []) {
    const trimmed = String(entry).trim();
    if (trimmed) caps.add(trimmed.toLowerCase());
  }
  const accounts = cfg.telegram?.accounts;
  if (accounts && typeof accounts === "object") {
    for (const account of Object.values(accounts)) {
      const accountCaps = (account as { capabilities?: unknown })?.capabilities;
      if (!Array.isArray(accountCaps)) continue;
      for (const entry of accountCaps) {
        const trimmed = String(entry).trim();
        if (trimmed) caps.add(trimmed.toLowerCase());
      }
    }
  }
  return caps.has("inlinebuttons");
}

function buildMessageActionList(cfg: ClawdbotConfig) {
  const actions = new Set<string>(["send"]);

  const discordAccounts = listEnabledDiscordAccounts(cfg).filter(
    (account) => account.tokenSource !== "none",
  );
  const discordEnabled = discordAccounts.length > 0;
  const discordGate = createActionGate(cfg.discord?.actions);

  const slackAccounts = listEnabledSlackAccounts(cfg).filter(
    (account) => account.botTokenSource !== "none",
  );
  const slackEnabled = slackAccounts.length > 0;
  const isSlackActionEnabled = (key: string, defaultValue = true) => {
    if (!slackEnabled) return false;
    for (const account of slackAccounts) {
      const gate = createActionGate(
        (account.actions ?? cfg.slack?.actions) as Record<
          string,
          boolean | undefined
        >,
      );
      if (gate(key, defaultValue)) return true;
    }
    return false;
  };

  const telegramAccounts = listEnabledTelegramAccounts(cfg).filter(
    (account) => account.tokenSource !== "none",
  );
  const telegramEnabled = telegramAccounts.length > 0;
  const telegramGate = createActionGate(cfg.telegram?.actions);

  const whatsappGate = createActionGate(cfg.whatsapp?.actions);

  const canDiscordReactions = discordEnabled && discordGate("reactions");
  const canSlackReactions = isSlackActionEnabled("reactions");
  const canTelegramReactions = telegramEnabled && telegramGate("reactions");
  const canWhatsAppReactions = cfg.whatsapp ? whatsappGate("reactions") : false;
  const canAnyReactions =
    canDiscordReactions ||
    canSlackReactions ||
    canTelegramReactions ||
    canWhatsAppReactions;
  if (canAnyReactions) actions.add("react");
  if (canDiscordReactions || canSlackReactions) actions.add("reactions");

  const canDiscordMessages = discordEnabled && discordGate("messages");
  const canSlackMessages = isSlackActionEnabled("messages");
  if (canDiscordMessages || canSlackMessages) {
    actions.add("read");
    actions.add("edit");
    actions.add("delete");
  }

  const canDiscordPins = discordEnabled && discordGate("pins");
  const canSlackPins = isSlackActionEnabled("pins");
  if (canDiscordPins || canSlackPins) {
    actions.add("pin");
    actions.add("unpin");
    actions.add("list-pins");
  }

  const msteamsEnabled =
    cfg.msteams?.enabled !== false &&
    Boolean(cfg.msteams && resolveMSTeamsCredentials(cfg.msteams));
  const canDiscordPolls = discordEnabled && discordGate("polls");
  const canWhatsAppPolls = cfg.whatsapp ? whatsappGate("polls") : false;
  if (canDiscordPolls || canWhatsAppPolls || msteamsEnabled)
    actions.add("poll");
  if (discordEnabled && discordGate("permissions")) actions.add("permissions");
  if (discordEnabled && discordGate("threads")) {
    actions.add("thread-create");
    actions.add("thread-list");
    actions.add("thread-reply");
  }
  if (discordEnabled && discordGate("search")) actions.add("search");
  if (discordEnabled && discordGate("stickers")) actions.add("sticker");
  if (
    (discordEnabled && discordGate("memberInfo")) ||
    isSlackActionEnabled("memberInfo")
  ) {
    actions.add("member-info");
  }
  if (discordEnabled && discordGate("roleInfo")) actions.add("role-info");
  if (
    (discordEnabled && discordGate("reactions")) ||
    isSlackActionEnabled("emojiList")
  ) {
    actions.add("emoji-list");
  }
  if (discordEnabled && discordGate("emojiUploads"))
    actions.add("emoji-upload");
  if (discordEnabled && discordGate("stickerUploads"))
    actions.add("sticker-upload");

  const canDiscordRoles = discordEnabled && discordGate("roles", false);
  if (canDiscordRoles) {
    actions.add("role-add");
    actions.add("role-remove");
  }

  if (discordEnabled && discordGate("channelInfo")) {
    actions.add("channel-info");
    actions.add("channel-list");
  }
  if (discordEnabled && discordGate("voiceStatus")) actions.add("voice-status");
  if (discordEnabled && discordGate("events")) {
    actions.add("event-list");
    actions.add("event-create");
  }
  if (discordEnabled && discordGate("moderation", false)) {
    actions.add("timeout");
    actions.add("kick");
    actions.add("ban");
  }

  return Array.from(actions);
}

function buildMessageToolSchema(cfg: ClawdbotConfig) {
  const actions = buildMessageActionList(cfg);
  const telegramEnabled = listEnabledTelegramAccounts(cfg).some(
    (account) => account.tokenSource !== "none",
  );
  const includeButtons = telegramEnabled && hasTelegramInlineButtons(cfg);
  return buildMessageToolSchemaFromActions(actions, { includeButtons });
}

function resolveAgentAccountId(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return normalizeAccountId(trimmed);
}

export function createMessageTool(options?: MessageToolOptions): AnyAgentTool {
  const agentAccountId = resolveAgentAccountId(options?.agentAccountId);
  const schema = options?.config
    ? buildMessageToolSchema(options.config)
    : MessageToolSchema;
  return {
    label: "Message",
    name: "message",
    description:
      "Send messages and provider-specific actions (Discord/Slack/Telegram/WhatsApp/Signal/iMessage/MS Teams).",
    parameters: schema,
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
        let message = readStringParam(params, "message", {
          required: true,
          allowEmpty: true,
        });
        const parsed = parseReplyDirectives(message);
        message = parsed.text;
        const mediaUrl =
          readStringParam(params, "media", { trim: false }) ??
          (parsed.mediaUrls?.[0] || parsed.mediaUrl);
        const replyTo =
          readStringParam(params, "replyTo") ?? parsed.replyToId;
        const threadId = readStringParam(params, "threadId");
        const buttons = params.buttons;
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
            {
              currentChannelId: options?.currentChannelId,
              currentThreadTs: options?.currentThreadTs,
              replyToMode: options?.replyToMode,
              hasRepliedRef: options?.hasRepliedRef,
            },
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
              accountId: accountId ?? undefined,
              buttons,
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
              accountId: accountId ?? undefined,
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
        let content = readStringParam(params, "message", { required: true });
        const parsed = parseReplyDirectives(content);
        content = parsed.text;
        const mediaUrl =
          readStringParam(params, "media", { trim: false }) ??
          (parsed.mediaUrls?.[0] || parsed.mediaUrl);
        const replyTo =
          readStringParam(params, "replyTo") ?? parsed.replyToId;
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
