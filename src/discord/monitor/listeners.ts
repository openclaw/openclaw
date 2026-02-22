import {
  ChannelType,
  type Client,
  MessageCreateListener,
  MessageReactionAddListener,
  MessageReactionRemoveListener,
  PresenceUpdateListener,
  type User,
} from "@buape/carbon";
import { danger } from "../../globals.js";
import { formatDurationSeconds } from "../../infra/format-time/format-duration.ts";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveAgentRoute } from "../../routing/resolve-route.js";
import {
  normalizeDiscordSlug,
  resolveDiscordChannelConfigWithFallback,
  resolveDiscordGuildEntry,
  shouldEmitDiscordReactionNotification,
} from "./allow-list.js";
import { formatDiscordReactionEmoji, formatDiscordUserTag } from "./format.js";
import { resolveDiscordChannelInfo } from "./message-utils.js";
import { setPresence } from "./presence-cache.js";

type LoadedConfig = ReturnType<typeof import("../../config/config.js").loadConfig>;
type RuntimeEnv = import("../../runtime.js").RuntimeEnv;
type Logger = ReturnType<typeof import("../../logging/subsystem.js").createSubsystemLogger>;

export type DiscordMessageEvent = Parameters<MessageCreateListener["handle"]>[0];

export type DiscordMessageHandler = (data: DiscordMessageEvent, client: Client) => Promise<void>;

type DiscordReactionEvent = Parameters<MessageReactionAddListener["handle"]>[0];

type DiscordReactionListenerParams = {
  cfg: LoadedConfig;
  accountId: string;
  runtime: RuntimeEnv;
  botUserId?: string;
  guildEntries?: Record<string, import("./allow-list.js").DiscordGuildEntryResolved>;
  logger: Logger;
};

const DISCORD_SLOW_LISTENER_THRESHOLD_MS = 30_000;
const discordEventQueueLog = createSubsystemLogger("discord/event-queue");

function logSlowDiscordListener(params: {
  logger: Logger | undefined;
  listener: string;
  event: string;
  durationMs: number;
}) {
  if (params.durationMs < DISCORD_SLOW_LISTENER_THRESHOLD_MS) {
    return;
  }
  const duration = formatDurationSeconds(params.durationMs, {
    decimals: 1,
    unit: "seconds",
  });
  const message = `Slow listener detected: ${params.listener} took ${duration} for event ${params.event}`;
  const logger = params.logger ?? discordEventQueueLog;
  logger.warn("Slow listener detected", {
    listener: params.listener,
    event: params.event,
    durationMs: params.durationMs,
    duration,
    consoleMessage: message,
  });
}

async function runDiscordListenerWithSlowLog(params: {
  logger: Logger | undefined;
  listener: string;
  event: string;
  run: () => Promise<void>;
  onError?: (err: unknown) => void;
}) {
  const startedAt = Date.now();
  try {
    await params.run();
  } catch (err) {
    if (params.onError) {
      params.onError(err);
      return;
    }
    throw err;
  } finally {
    logSlowDiscordListener({
      logger: params.logger,
      listener: params.listener,
      event: params.event,
      durationMs: Date.now() - startedAt,
    });
  }
}

export function registerDiscordListener(listeners: Array<object>, listener: object) {
  if (listeners.some((existing) => existing.constructor === listener.constructor)) {
    return false;
  }
  listeners.push(listener);
  return true;
}

export class DiscordMessageListener extends MessageCreateListener {
  constructor(
    private handler: DiscordMessageHandler,
    private logger?: Logger,
  ) {
    super();
  }

  async handle(data: DiscordMessageEvent, client: Client) {
    await runDiscordListenerWithSlowLog({
      logger: this.logger,
      listener: this.constructor.name,
      event: this.type,
      run: () => this.handler(data, client),
      onError: (err) => {
        const logger = this.logger ?? discordEventQueueLog;
        logger.error(danger(`discord handler failed: ${String(err)}`));
      },
    });
  }
}

export class DiscordReactionListener extends MessageReactionAddListener {
  constructor(private params: DiscordReactionListenerParams) {
    super();
  }

  async handle(data: DiscordReactionEvent, client: Client) {
    await runDiscordReactionHandler({
      data,
      client,
      action: "added",
      handlerParams: this.params,
      listener: this.constructor.name,
      event: this.type,
    });
  }
}

export class DiscordReactionRemoveListener extends MessageReactionRemoveListener {
  constructor(private params: DiscordReactionListenerParams) {
    super();
  }

  async handle(data: DiscordReactionEvent, client: Client) {
    await runDiscordReactionHandler({
      data,
      client,
      action: "removed",
      handlerParams: this.params,
      listener: this.constructor.name,
      event: this.type,
    });
  }
}

async function runDiscordReactionHandler(params: {
  data: DiscordReactionEvent;
  client: Client;
  action: "added" | "removed";
  handlerParams: DiscordReactionListenerParams;
  listener: string;
  event: string;
}): Promise<void> {
  await runDiscordListenerWithSlowLog({
    logger: params.handlerParams.logger,
    listener: params.listener,
    event: params.event,
    run: () =>
      handleDiscordReactionEvent({
        data: params.data,
        client: params.client,
        action: params.action,
        cfg: params.handlerParams.cfg,
        accountId: params.handlerParams.accountId,
        botUserId: params.handlerParams.botUserId,
        guildEntries: params.handlerParams.guildEntries,
        logger: params.handlerParams.logger,
      }),
  });
}

async function handleDiscordReactionEvent(params: {
  data: DiscordReactionEvent;
  client: Client;
  action: "added" | "removed";
  cfg: LoadedConfig;
  accountId: string;
  botUserId?: string;
  guildEntries?: Record<string, import("./allow-list.js").DiscordGuildEntryResolved>;
  logger: Logger;
}) {
  try {
    const { data, client, action, botUserId, guildEntries } = params;
    if (!("user" in data)) {
      return;
    }
    const user = data.user;
    if (!user || user.bot) {
      return;
    }

    // Early exit: skip bot's own reactions before expensive network calls
    if (botUserId && user.id === botUserId) {
      return;
    }

    const isGuildMessage = Boolean(data.guild_id);
    const guildInfo = isGuildMessage
      ? resolveDiscordGuildEntry({
          guild: data.guild ?? undefined,
          guildEntries,
        })
      : null;
    if (isGuildMessage && guildEntries && Object.keys(guildEntries).length > 0 && !guildInfo) {
      return;
    }

    const channel = await client.fetchChannel(data.channel_id);
    if (!channel) {
      return;
    }
    const channelName = "name" in channel ? (channel.name ?? undefined) : undefined;
    const channelSlug = channelName ? normalizeDiscordSlug(channelName) : "";
    const channelType = "type" in channel ? channel.type : undefined;
    const isDirectMessage = channelType === ChannelType.DM;
    const isGroupDm = channelType === ChannelType.GroupDM;
    const isThreadChannel =
      channelType === ChannelType.PublicThread ||
      channelType === ChannelType.PrivateThread ||
      channelType === ChannelType.AnnouncementThread;
    let parentId = "parentId" in channel ? (channel.parentId ?? undefined) : undefined;
    let parentName: string | undefined;
    let parentSlug = "";
    const memberRoleIds = Array.isArray(data.rawMember?.roles)
      ? data.rawMember.roles.map((roleId: string) => String(roleId))
      : [];
    let reactionBase: { baseText: string; contextKey: string } | null = null;
    const resolveReactionBase = () => {
      if (reactionBase) {
        return reactionBase;
      }
      const emojiLabel = formatDiscordReactionEmoji(data.emoji);
      const actorLabel = formatDiscordUserTag(user);
      const guildSlug =
        guildInfo?.slug ||
        (data.guild?.name
          ? normalizeDiscordSlug(data.guild.name)
          : (data.guild_id ?? (isGroupDm ? "group-dm" : "dm")));
      const channelLabel = channelSlug
        ? `#${channelSlug}`
        : channelName
          ? `#${normalizeDiscordSlug(channelName)}`
          : `#${data.channel_id}`;
      const baseText = `Discord reaction ${action}: ${emojiLabel} by ${actorLabel} on ${guildSlug} ${channelLabel} msg ${data.message_id}`;
      const contextKey = `discord:reaction:${action}:${data.message_id}:${user.id}:${emojiLabel}`;
      reactionBase = { baseText, contextKey };
      return reactionBase;
    };
    const emitReaction = (text: string, parentPeerId?: string) => {
      const { contextKey } = resolveReactionBase();
      const route = resolveAgentRoute({
        cfg: params.cfg,
        channel: "discord",
        accountId: params.accountId,
        guildId: data.guild_id ?? undefined,
        memberRoleIds,
        peer: {
          kind: isDirectMessage ? "direct" : isGroupDm ? "group" : "channel",
          id: isDirectMessage ? user.id : data.channel_id,
        },
        parentPeer: parentPeerId ? { kind: "channel", id: parentPeerId } : undefined,
      });
      enqueueSystemEvent(text, {
        sessionKey: route.sessionKey,
        contextKey,
      });
    };
    const shouldNotifyReaction = (options: {
      mode: "off" | "own" | "all" | "allowlist";
      messageAuthorId?: string;
    }) =>
      shouldEmitDiscordReactionNotification({
        mode: options.mode,
        botId: botUserId,
        messageAuthorId: options.messageAuthorId,
        userId: user.id,
        userName: user.username,
        userTag: formatDiscordUserTag(user),
        allowlist: guildInfo?.users,
      });
    const emitReactionWithAuthor = (message: { author?: User } | null) => {
      const { baseText } = resolveReactionBase();
      const authorLabel = message?.author ? formatDiscordUserTag(message.author) : undefined;
      const text = authorLabel ? `${baseText} from ${authorLabel}` : baseText;
      emitReaction(text, parentId);
    };
    const loadThreadParentInfo = async () => {
      if (!parentId) {
        return;
      }
      const parentInfo = await resolveDiscordChannelInfo(client, parentId);
      parentName = parentInfo?.name;
      parentSlug = parentName ? normalizeDiscordSlug(parentName) : "";
    };
    const resolveThreadChannelConfig = () =>
      resolveDiscordChannelConfigWithFallback({
        guildInfo,
        channelId: data.channel_id,
        channelName,
        channelSlug,
        parentId,
        parentName,
        parentSlug,
        scope: "thread",
      });

    // Parallelize async operations for thread channels
    if (isThreadChannel) {
      const reactionMode = guildInfo?.reactionNotifications ?? "own";

      // Early exit: skip fetching message if notifications are off
      if (reactionMode === "off") {
        return;
      }

      const channelInfoPromise = parentId
        ? Promise.resolve({ parentId })
        : resolveDiscordChannelInfo(client, data.channel_id);

      // Fast path: for "all" and "allowlist" modes, we don't need to fetch the message
      if (reactionMode === "all" || reactionMode === "allowlist") {
        const channelInfo = await channelInfoPromise;
        parentId = channelInfo?.parentId;
        await loadThreadParentInfo();

        const channelConfig = resolveThreadChannelConfig();
        if (channelConfig?.allowed === false) {
          return;
        }

        // For allowlist mode, check if user is in allowlist first
        if (reactionMode === "allowlist") {
          if (!shouldNotifyReaction({ mode: reactionMode })) {
            return;
          }
        }

        const { baseText } = resolveReactionBase();
        emitReaction(baseText, parentId);
        return;
      }

      // For "own" mode, we need to fetch the message to check the author
      const messagePromise = data.message.fetch().catch(() => null);

      const [channelInfo, message] = await Promise.all([channelInfoPromise, messagePromise]);
      parentId = channelInfo?.parentId;
      await loadThreadParentInfo();

      const channelConfig = resolveThreadChannelConfig();
      if (channelConfig?.allowed === false) {
        return;
      }

      const messageAuthorId = message?.author?.id ?? undefined;
      if (!shouldNotifyReaction({ mode: reactionMode, messageAuthorId })) {
        return;
      }

      emitReactionWithAuthor(message);
      return;
    }

    // Non-thread channel path
    const channelConfig = resolveDiscordChannelConfigWithFallback({
      guildInfo,
      channelId: data.channel_id,
      channelName,
      channelSlug,
      parentId,
      parentName,
      parentSlug,
      scope: "channel",
    });
    if (channelConfig?.allowed === false) {
      return;
    }

    const reactionMode = guildInfo?.reactionNotifications ?? "own";

    // Early exit: skip fetching message if notifications are off
    if (reactionMode === "off") {
      return;
    }

    // Fast path: for "all" and "allowlist" modes, we don't need to fetch the message
    if (reactionMode === "all" || reactionMode === "allowlist") {
      // For allowlist mode, check if user is in allowlist first
      if (reactionMode === "allowlist") {
        if (!shouldNotifyReaction({ mode: reactionMode })) {
          return;
        }
      }

      const { baseText } = resolveReactionBase();
      emitReaction(baseText, parentId);
      return;
    }

    // For "own" mode, we need to fetch the message to check the author
    const message = await data.message.fetch().catch(() => null);
    const messageAuthorId = message?.author?.id ?? undefined;
    if (!shouldNotifyReaction({ mode: reactionMode, messageAuthorId })) {
      return;
    }

    if (guildInfo?.reactionDelivery === "immediate") {
      // Immediate delivery path — bypass deferred helpers and route directly
      const emojiLabel = formatDiscordReactionEmoji(data.emoji);
      const actorLabel = formatDiscordUserTag(user);
      const guildSlug =
        guildInfo?.slug ||
        (data.guild?.name
          ? normalizeDiscordSlug(data.guild.name)
          : (data.guild_id ?? (isGroupDm ? "group-dm" : "dm")));
      const channelLabel = channelSlug
        ? `#${channelSlug}`
        : channelName
          ? `#${normalizeDiscordSlug(channelName)}`
          : `#${data.channel_id}`;
      const authorLabel = message?.author ? formatDiscordUserTag(message.author) : undefined;
      const baseText = `Discord reaction ${action}: ${emojiLabel} by ${actorLabel} on ${guildSlug} ${channelLabel} msg ${data.message_id}`;
      const text = authorLabel ? `${baseText} from ${authorLabel}` : baseText;
      const route = resolveAgentRoute({
        cfg: params.cfg,
        channel: "discord",
        accountId: params.accountId,
        guildId: data.guild_id ?? undefined,
        memberRoleIds,
        peer: {
          kind: isDirectMessage ? "direct" : isGroupDm ? "group" : "channel",
          id: isDirectMessage ? user.id : data.channel_id,
        },
        parentPeer: parentId ? { kind: "channel", id: parentId } : undefined,
      });
      try {
        const { getReactionDebouncer } = await import("../../infra/reaction-dispatch/index.js");
        const debouncer = getReactionDebouncer(guildInfo.reactionBundleWindowMs);

        const reactedMessageContent = guildInfo.reactionIncludeMessage
          ? message?.content || undefined
          : undefined;
        const reactedMessageAuthor =
          guildInfo.reactionIncludeMessage && message?.author
            ? formatDiscordUserTag(message.author)
            : undefined;

        await debouncer.enqueue(
          {
            emoji: emojiLabel,
            actorLabel,
            actorId: user.id,
            action,
            ts: Date.now(),
          },
          {
            channel: "discord",
            accountId: params.accountId,
            sessionKey: route.sessionKey,
            messageId: data.message_id,
            reactedMessageContent,
            reactedMessageAuthor,
            conversationLabel: `${guildSlug} ${channelLabel}`,
          },
        );
      } catch (err) {
        params.logger.error(
          danger(`discord reaction dispatch failed, falling back to deferred: ${String(err)}`),
        );
        enqueueSystemEvent(text, {
          sessionKey: route.sessionKey,
          contextKey: `discord:reaction:${action}:${data.message_id}:${user.id}:${emojiLabel}`,
        });
      }
    } else {
      // Deferred path — use upstream helper
      emitReactionWithAuthor(message);
    }
  } catch (err) {
    params.logger.error(danger(`discord reaction handler failed: ${String(err)}`));
  }
}

type PresenceUpdateEvent = Parameters<PresenceUpdateListener["handle"]>[0];

export class DiscordPresenceListener extends PresenceUpdateListener {
  private logger?: Logger;
  private accountId?: string;

  constructor(params: { logger?: Logger; accountId?: string }) {
    super();
    this.logger = params.logger;
    this.accountId = params.accountId;
  }

  async handle(data: PresenceUpdateEvent) {
    try {
      const userId =
        "user" in data && data.user && typeof data.user === "object" && "id" in data.user
          ? String(data.user.id)
          : undefined;
      if (!userId) {
        return;
      }
      setPresence(
        this.accountId,
        userId,
        data as import("discord-api-types/v10").GatewayPresenceUpdate,
      );
    } catch (err) {
      const logger = this.logger ?? discordEventQueueLog;
      logger.error(danger(`discord presence handler failed: ${String(err)}`));
    }
  }
}
