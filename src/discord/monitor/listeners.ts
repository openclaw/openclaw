import {
  ChannelType,
  type Client,
  MessageCreateListener,
  MessageReactionAddListener,
  MessageReactionRemoveListener,
  PresenceUpdateListener,
} from "@buape/carbon";

import { danger } from "../../globals.js";
import { formatDurationSeconds } from "../../infra/format-duration.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { setPresence } from "./presence-cache.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveAgentRoute } from "../../routing/resolve-route.js";
import {
  normalizeDiscordSlug,
  resolveDiscordChannelConfigWithFallback,
  resolveDiscordGuildEntry,
  shouldEmitDiscordReactionNotification,
  type DiscordReactionTriggerResolved,
} from "./allow-list.js";
import { formatDiscordReactionEmoji, formatDiscordUserTag } from "./format.js";
import { resolveDiscordChannelInfo } from "./message-utils.js";

// ============================================================================
// Reaction Trigger Support
// ============================================================================

// Cache of recent bot messages for reaction trigger feature
// Key: channelId:messageId, Value: { timestamp, content }
type BotMessageCacheEntry = {
  timestamp: number;
  content: string;
  channelId: string;
};

const botMessageCache = new Map<string, BotMessageCacheEntry>();
const BOT_MESSAGE_CACHE_MAX_SIZE = 1000;
const BOT_MESSAGE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Default emoji classifications
const DEFAULT_POSITIVE_EMOJIS = ["👍", "✅", "👌", "❤️", "🙌", "⭐", "🎉", "💯", "✔️", "🆗", "👏"];
const DEFAULT_NEGATIVE_EMOJIS = ["👎", "❌", "🚫", "⛔", "🛑"];

export function cacheBotMessage(params: { channelId: string; messageId: string; content: string }) {
  const key = `${params.channelId}:${params.messageId}`;
  botMessageCache.set(key, {
    timestamp: Date.now(),
    content: params.content,
    channelId: params.channelId,
  });

  // Cleanup old entries
  if (botMessageCache.size > BOT_MESSAGE_CACHE_MAX_SIZE) {
    const now = Date.now();
    for (const [k, v] of botMessageCache) {
      if (now - v.timestamp > BOT_MESSAGE_CACHE_TTL_MS) {
        botMessageCache.delete(k);
      }
    }
  }
}

function getBotMessageFromCache(channelId: string, messageId: string): BotMessageCacheEntry | null {
  const key = `${channelId}:${messageId}`;
  const entry = botMessageCache.get(key);
  if (!entry) return null;
  // Check TTL
  if (Date.now() - entry.timestamp > BOT_MESSAGE_CACHE_TTL_MS) {
    botMessageCache.delete(key);
    return null;
  }
  return entry;
}

type ReactionSentiment = "positive" | "negative" | "neutral";

function classifyReactionEmoji(
  emoji: string,
  config?: DiscordReactionTriggerResolved,
): ReactionSentiment {
  const positiveEmojis = config?.positiveEmojis ?? DEFAULT_POSITIVE_EMOJIS;
  const negativeEmojis = config?.negativeEmojis ?? DEFAULT_NEGATIVE_EMOJIS;

  if (positiveEmojis.includes(emoji)) return "positive";
  if (negativeEmojis.includes(emoji)) return "negative";
  return "neutral";
}

function shouldTriggerOnReaction(params: {
  botUserId?: string;
  messageAuthorId?: string;
  messageTimestamp: number;
  config?: DiscordReactionTriggerResolved;
  emojiSentiment: ReactionSentiment;
}): boolean {
  const { botUserId, messageAuthorId, messageTimestamp, config, emojiSentiment } = params;

  // Must be enabled
  if (!config?.enabled) return false;

  // Must be bot's own message
  if (!botUserId || messageAuthorId !== botUserId) return false;

  // Must be within time window
  const windowMs = (config.windowSeconds ?? 60) * 1000;
  const elapsed = Date.now() - messageTimestamp;
  if (elapsed > windowMs) return false;

  // Must be positive or negative (not neutral)
  if (emojiSentiment === "neutral") return false;

  return true;
}

// ============================================================================

type LoadedConfig = ReturnType<typeof import("../../config/config.js").loadConfig>;
type RuntimeEnv = import("../../runtime.js").RuntimeEnv;
type Logger = ReturnType<typeof import("../../logging/subsystem.js").createSubsystemLogger>;

export type DiscordMessageEvent = Parameters<MessageCreateListener["handle"]>[0];

export type DiscordMessageHandler = (data: DiscordMessageEvent, client: Client) => Promise<void>;

type DiscordReactionEvent = Parameters<MessageReactionAddListener["handle"]>[0];

const DISCORD_SLOW_LISTENER_THRESHOLD_MS = 30_000;
const discordEventQueueLog = createSubsystemLogger("discord/event-queue");

function logSlowDiscordListener(params: {
  logger: Logger | undefined;
  listener: string;
  event: string;
  durationMs: number;
}) {
  if (params.durationMs < DISCORD_SLOW_LISTENER_THRESHOLD_MS) return;
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
    const startedAt = Date.now();
    const task = Promise.resolve(this.handler(data, client));
    void task
      .catch((err) => {
        const logger = this.logger ?? discordEventQueueLog;
        logger.error(danger(`discord handler failed: ${String(err)}`));
      })
      .finally(() => {
        logSlowDiscordListener({
          logger: this.logger,
          listener: this.constructor.name,
          event: this.type,
          durationMs: Date.now() - startedAt,
        });
      });
  }
}

export type ReactionTriggerCallback = (params: {
  channelId: string;
  messageId: string;
  originalContent: string;
  emoji: string;
  sentiment: ReactionSentiment;
  userId: string;
  userName: string;
  client: Client;
}) => Promise<void>;

export class DiscordReactionListener extends MessageReactionAddListener {
  constructor(
    private params: {
      cfg: LoadedConfig;
      accountId: string;
      runtime: RuntimeEnv;
      botUserId?: string;
      guildEntries?: Record<string, import("./allow-list.js").DiscordGuildEntryResolved>;
      logger: Logger;
      onReactionTrigger?: ReactionTriggerCallback;
    },
  ) {
    super();
  }

  async handle(data: DiscordReactionEvent, client: Client) {
    const startedAt = Date.now();
    try {
      await handleDiscordReactionEvent({
        data,
        client,
        action: "added",
        cfg: this.params.cfg,
        accountId: this.params.accountId,
        botUserId: this.params.botUserId,
        guildEntries: this.params.guildEntries,
        logger: this.params.logger,
        onReactionTrigger: this.params.onReactionTrigger,
      });
    } finally {
      logSlowDiscordListener({
        logger: this.params.logger,
        listener: this.constructor.name,
        event: this.type,
        durationMs: Date.now() - startedAt,
      });
    }
  }
}

export class DiscordReactionRemoveListener extends MessageReactionRemoveListener {
  constructor(
    private params: {
      cfg: LoadedConfig;
      accountId: string;
      runtime: RuntimeEnv;
      botUserId?: string;
      guildEntries?: Record<string, import("./allow-list.js").DiscordGuildEntryResolved>;
      logger: Logger;
    },
  ) {
    super();
  }

  async handle(data: DiscordReactionEvent, client: Client) {
    const startedAt = Date.now();
    try {
      await handleDiscordReactionEvent({
        data,
        client,
        action: "removed",
        cfg: this.params.cfg,
        accountId: this.params.accountId,
        botUserId: this.params.botUserId,
        guildEntries: this.params.guildEntries,
        logger: this.params.logger,
      });
    } finally {
      logSlowDiscordListener({
        logger: this.params.logger,
        listener: this.constructor.name,
        event: this.type,
        durationMs: Date.now() - startedAt,
      });
    }
  }
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
  onReactionTrigger?: ReactionTriggerCallback;
}) {
  try {
    const { data, client, action, botUserId, guildEntries, onReactionTrigger } = params;
    if (!("user" in data)) return;
    const user = data.user;
    if (!user || user.bot) return;
    if (!data.guild_id) return;

    const guildInfo = resolveDiscordGuildEntry({
      guild: data.guild ?? undefined,
      guildEntries,
    });
    if (guildEntries && Object.keys(guildEntries).length > 0 && !guildInfo) {
      return;
    }

    const channel = await client.fetchChannel(data.channel_id);
    if (!channel) return;
    const channelName = "name" in channel ? (channel.name ?? undefined) : undefined;
    const channelSlug = channelName ? normalizeDiscordSlug(channelName) : "";
    const channelType = "type" in channel ? channel.type : undefined;
    const isThreadChannel =
      channelType === ChannelType.PublicThread ||
      channelType === ChannelType.PrivateThread ||
      channelType === ChannelType.AnnouncementThread;
    let parentId = "parentId" in channel ? (channel.parentId ?? undefined) : undefined;
    let parentName: string | undefined;
    let parentSlug = "";
    if (isThreadChannel) {
      if (!parentId) {
        const channelInfo = await resolveDiscordChannelInfo(client, data.channel_id);
        parentId = channelInfo?.parentId;
      }
      if (parentId) {
        const parentInfo = await resolveDiscordChannelInfo(client, parentId);
        parentName = parentInfo?.name;
        parentSlug = parentName ? normalizeDiscordSlug(parentName) : "";
      }
    }
    const channelConfig = resolveDiscordChannelConfigWithFallback({
      guildInfo,
      channelId: data.channel_id,
      channelName,
      channelSlug,
      parentId,
      parentName,
      parentSlug,
      scope: isThreadChannel ? "thread" : "channel",
    });
    if (channelConfig?.allowed === false) return;

    if (botUserId && user.id === botUserId) return;

    const reactionMode = guildInfo?.reactionNotifications ?? "own";
    const message = await data.message.fetch().catch(() => null);
    const messageAuthorId = message?.author?.id ?? undefined;
    const shouldNotify = shouldEmitDiscordReactionNotification({
      mode: reactionMode,
      botId: botUserId,
      messageAuthorId,
      userId: user.id,
      userName: user.username,
      userTag: formatDiscordUserTag(user),
      allowlist: guildInfo?.users,
    });
    if (!shouldNotify) return;

    const emojiLabel = formatDiscordReactionEmoji(data.emoji);
    const actorLabel = formatDiscordUserTag(user);
    const guildSlug =
      guildInfo?.slug || (data.guild?.name ? normalizeDiscordSlug(data.guild.name) : data.guild_id);
    const channelLabel = channelSlug
      ? `#${channelSlug}`
      : channelName
        ? `#${normalizeDiscordSlug(channelName)}`
        : `#${data.channel_id}`;
    const authorLabel = message?.author ? formatDiscordUserTag(message.author) : undefined;
    const route = resolveAgentRoute({
      cfg: params.cfg,
      channel: "discord",
      accountId: params.accountId,
      guildId: data.guild_id ?? undefined,
      peer: { kind: "channel", id: data.channel_id },
    });

    // Check reaction trigger conditions (only for "added" action)
    if (action === "added" && onReactionTrigger) {
      const reactionTriggerConfig = guildInfo?.reactionTrigger;
      const emojiSentiment = classifyReactionEmoji(emojiLabel, reactionTriggerConfig);

      // Try to get cached bot message info
      const cachedMessage = getBotMessageFromCache(data.channel_id, data.message_id);
      const messageTimestamp = cachedMessage?.timestamp ?? message?.createdAt?.getTime() ?? 0;
      const messageContent = cachedMessage?.content ?? message?.content ?? "";

      const shouldTrigger = shouldTriggerOnReaction({
        botUserId,
        messageAuthorId,
        messageTimestamp,
        config: reactionTriggerConfig,
        emojiSentiment,
      });

      if (shouldTrigger) {
        // Build enhanced system event text for reaction trigger
        const sentimentLabel = emojiSentiment === "positive" ? "POSITIVE" : "NEGATIVE";
        const triggerText = `[Reaction Trigger] ${sentimentLabel} response (${emojiLabel}) from ${actorLabel} to bot message: "${messageContent.slice(0, 200)}${messageContent.length > 200 ? "..." : ""}"`;

        enqueueSystemEvent(triggerText, {
          sessionKey: route.sessionKey,
          contextKey: `discord:reaction-trigger:${data.message_id}:${user.id}:${emojiLabel}`,
        });

        // Call the trigger callback to wake the session
        await onReactionTrigger({
          channelId: data.channel_id,
          messageId: data.message_id,
          originalContent: messageContent,
          emoji: emojiLabel,
          sentiment: emojiSentiment,
          userId: user.id,
          userName: user.username || actorLabel || user.id,
          client,
        });

        return; // Don't also emit regular notification
      }
    }

    // Regular reaction notification (existing behavior)
    const baseText = `Discord reaction ${action}: ${emojiLabel} by ${actorLabel} on ${guildSlug} ${channelLabel} msg ${data.message_id}`;
    const text = authorLabel ? `${baseText} from ${authorLabel}` : baseText;
    enqueueSystemEvent(text, {
      sessionKey: route.sessionKey,
      contextKey: `discord:reaction:${action}:${data.message_id}:${user.id}:${emojiLabel}`,
    });
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
      if (!userId) return;
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
