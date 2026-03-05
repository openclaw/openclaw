import {
  ChannelType,
  type Client,
  MessageCreateListener,
  MessageReactionAddListener,
  MessageReactionRemoveListener,
  PresenceUpdateListener,
  ThreadUpdateListener,
  type User,
} from "@buape/carbon";
import type { OpenClawConfig } from "../../config/config.js";
import { danger, logVerbose } from "../../globals.js";
import { formatDurationSeconds } from "../../infra/format-time/format-duration.ts";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { resolveAgentRoute } from "../../routing/resolve-route.js";
import {
  readStoreAllowFromForDmPolicy,
  resolveDmGroupAccessWithLists,
} from "../../security/dm-policy-shared.js";
import {
  isDiscordGroupAllowedByPolicy,
  normalizeDiscordAllowList,
  normalizeDiscordSlug,
  resolveDiscordAllowListMatch,
  resolveDiscordChannelConfigWithFallback,
  resolveGroupDmAllow,
  resolveDiscordGuildEntry,
  shouldDenyDiscordChannelByAllowedFlag,
  shouldEmitDiscordReactionNotification,
} from "./allow-list.js";
import { formatDiscordReactionEmoji, formatDiscordUserTag } from "./format.js";
import { resolveDiscordChannelInfo } from "./message-utils.js";
import { setPresence } from "./presence-cache.js";
import { isThreadArchived } from "./thread-bindings.discord-api.js";
import { closeDiscordThreadSessions } from "./thread-session-close.js";

type LoadedConfig = ReturnType<typeof import("../../config/config.js").loadConfig>;
type RuntimeEnv = import("../../runtime.js").RuntimeEnv;
type Logger = ReturnType<typeof import("../../logging/subsystem.js").createSubsystemLogger>;

export type DiscordMessageEvent = Parameters<MessageCreateListener["handle"]>[0];

export type DiscordMessageHandler = (
  data: DiscordMessageEvent,
  client: Client,
  options?: { abortSignal?: AbortSignal },
) => Promise<void>;

type DiscordReactionEvent = Parameters<MessageReactionAddListener["handle"]>[0];

type DiscordReactionListenerParams = {
  cfg: LoadedConfig;
  runtime: RuntimeEnv;
  logger: Logger;
  onEvent?: () => void;
} & DiscordReactionRoutingParams;

type DiscordReactionRoutingParams = {
  accountId: string;
  botUserId?: string;
  dmEnabled: boolean;
  groupDmEnabled: boolean;
  groupDmChannels: string[];
  dmPolicy: "open" | "pairing" | "allowlist" | "disabled";
  allowFrom: string[];
  groupPolicy: "open" | "allowlist" | "disabled";
  allowNameMatching: boolean;
  guildEntries?: Record<string, import("./allow-list.js").DiscordGuildEntryResolved>;
};

const DISCORD_SLOW_LISTENER_THRESHOLD_MS = 30_000;
const DISCORD_DEFAULT_LISTENER_TIMEOUT_MS = 120_000;
const discordEventQueueLog = createSubsystemLogger("discord/event-queue");

function normalizeDiscordListenerTimeoutMs(raw: number | undefined): number {
  if (!Number.isFinite(raw) || (raw ?? 0) <= 0) {
    return DISCORD_DEFAULT_LISTENER_TIMEOUT_MS;
  }
  return Math.max(1_000, Math.floor(raw!));
}

function formatListenerContextValue(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return null;
}

function formatListenerContextSuffix(context?: Record<string, unknown>): string {
  if (!context) {
    return "";
  }
  const entries = Object.entries(context).flatMap(([key, value]) => {
    const formatted = formatListenerContextValue(value);
    return formatted ? [`${key}=${formatted}`] : [];
  });
  if (entries.length === 0) {
    return "";
  }
  return ` (${entries.join(" ")})`;
}

function logSlowDiscordListener(params: {
  logger: Logger | undefined;
  listener: string;
  event: string;
  durationMs: number;
  context?: Record<string, unknown>;
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
    ...params.context,
    consoleMessage: `${message}${formatListenerContextSuffix(params.context)}`,
  });
}

async function runDiscordListenerWithSlowLog(params: {
  logger: Logger | undefined;
  listener: string;
  event: string;
  run: (abortSignal: AbortSignal) => Promise<void>;
  timeoutMs?: number;
  context?: Record<string, unknown>;
  onError?: (err: unknown) => void;
}) {
  const startedAt = Date.now();
  const timeoutMs = normalizeDiscordListenerTimeoutMs(params.timeoutMs);
  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  const logger = params.logger ?? discordEventQueueLog;
  const abortController = new AbortController();
  const runPromise = params.run(abortController.signal).catch((err) => {
    if (timedOut) {
      const errorName =
        err && typeof err === "object" && "name" in err ? String(err.name) : undefined;
      if (abortController.signal.aborted && errorName === "AbortError") {
        logger.warn(
          `discord handler canceled after timeout${formatListenerContextSuffix(params.context)}`,
        );
        return;
      }
      logger.error(
        danger(
          `discord handler failed after timeout: ${String(err)}${formatListenerContextSuffix(params.context)}`,
        ),
      );
      return;
    }
    throw err;
  });

  try {
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timeoutHandle = setTimeout(() => resolve("timeout"), timeoutMs);
      timeoutHandle.unref?.();
    });
    const result = await Promise.race([
      runPromise.then(() => "completed" as const),
      timeoutPromise,
    ]);
    if (result === "timeout") {
      timedOut = true;
      abortController.abort();
      logger.error(
        danger(
          `discord handler timed out after ${formatDurationSeconds(timeoutMs, {
            decimals: 1,
            unit: "seconds",
          })}${formatListenerContextSuffix(params.context)}`,
        ),
      );
      return;
    }
  } catch (err) {
    if (params.onError) {
      params.onError(err);
      return;
    }
    throw err;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    if (!timedOut) {
      logSlowDiscordListener({
        logger: params.logger,
        listener: params.listener,
        event: params.event,
        durationMs: Date.now() - startedAt,
        context: params.context,
      });
    }
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
  private readonly channelQueue = new KeyedAsyncQueue();
  private readonly listenerTimeoutMs: number;

  constructor(
    private handler: DiscordMessageHandler,
    private logger?: Logger,
    private onEvent?: () => void,
    options?: { timeoutMs?: number },
  ) {
    super();
    this.listenerTimeoutMs = normalizeDiscordListenerTimeoutMs(options?.timeoutMs);
  }

  async handle(data: DiscordMessageEvent, client: Client) {
    this.onEvent?.();
    const channelId = data.channel_id;
    const context = {
      channelId,
      messageId: (data as { message?: { id?: string } }).message?.id,
      guildId: (data as { guild_id?: string }).guild_id,
    } satisfies Record<string, unknown>;
    // Serialize messages within the same channel to preserve ordering,
    // but allow different channels to proceed in parallel so that
    // channel-bound agents are not blocked by each other.
    void this.channelQueue.enqueue(channelId, () =>
      runDiscordListenerWithSlowLog({
        logger: this.logger,
        listener: this.constructor.name,
        event: this.type,
        timeoutMs: this.listenerTimeoutMs,
        context,
        run: (abortSignal) => this.handler(data, client, { abortSignal }),
        onError: (err) => {
          const logger = this.logger ?? discordEventQueueLog;
          logger.error(danger(`discord handler failed: ${String(err)}`));
        },
      }),
    );
  }
}

export class DiscordReactionListener extends MessageReactionAddListener {
  constructor(private params: DiscordReactionListenerParams) {
    super();
  }

  async handle(data: DiscordReactionEvent, client: Client) {
    this.params.onEvent?.();
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
    this.params.onEvent?.();
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
    run: async () =>
      handleDiscordReactionEvent({
        data: params.data,
        client: params.client,
        action: params.action,
        cfg: params.handlerParams.cfg,
        accountId: params.handlerParams.accountId,
        botUserId: params.handlerParams.botUserId,
        dmEnabled: params.handlerParams.dmEnabled,
        groupDmEnabled: params.handlerParams.groupDmEnabled,
        groupDmChannels: params.handlerParams.groupDmChannels,
        dmPolicy: params.handlerParams.dmPolicy,
        allowFrom: params.handlerParams.allowFrom,
        groupPolicy: params.handlerParams.groupPolicy,
        allowNameMatching: params.handlerParams.allowNameMatching,
        guildEntries: params.handlerParams.guildEntries,
        logger: params.handlerParams.logger,
      }),
  });
}

type DiscordReactionIngressAuthorizationParams = {
  accountId: string;
  user: User;
  isDirectMessage: boolean;
  isGroupDm: boolean;
  isGuildMessage: boolean;
  channelId: string;
  channelName?: string;
  channelSlug: string;
  dmEnabled: boolean;
  groupDmEnabled: boolean;
  groupDmChannels: string[];
  dmPolicy: "open" | "pairing" | "allowlist" | "disabled";
  allowFrom: string[];
  groupPolicy: "open" | "allowlist" | "disabled";
  allowNameMatching: boolean;
  guildInfo: import("./allow-list.js").DiscordGuildEntryResolved | null;
  channelConfig?: { allowed?: boolean } | null;
};

async function authorizeDiscordReactionIngress(
  params: DiscordReactionIngressAuthorizationParams,
): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  if (params.isDirectMessage && !params.dmEnabled) {
    return { allowed: false, reason: "dm-disabled" };
  }
  if (params.isGroupDm && !params.groupDmEnabled) {
    return { allowed: false, reason: "group-dm-disabled" };
  }
  if (params.isDirectMessage) {
    const storeAllowFrom = await readStoreAllowFromForDmPolicy({
      provider: "discord",
      accountId: params.accountId,
      dmPolicy: params.dmPolicy,
    });
    const access = resolveDmGroupAccessWithLists({
      isGroup: false,
      dmPolicy: params.dmPolicy,
      groupPolicy: params.groupPolicy,
      allowFrom: params.allowFrom,
      groupAllowFrom: [],
      storeAllowFrom,
      isSenderAllowed: (allowEntries) => {
        const allowList = normalizeDiscordAllowList(allowEntries, ["discord:", "user:", "pk:"]);
        const allowMatch = allowList
          ? resolveDiscordAllowListMatch({
              allowList,
              candidate: {
                id: params.user.id,
                name: params.user.username,
                tag: formatDiscordUserTag(params.user),
              },
              allowNameMatching: params.allowNameMatching,
            })
          : { allowed: false };
        return allowMatch.allowed;
      },
    });
    if (access.decision !== "allow") {
      return { allowed: false, reason: access.reason };
    }
  }
  if (
    params.isGroupDm &&
    !resolveGroupDmAllow({
      channels: params.groupDmChannels,
      channelId: params.channelId,
      channelName: params.channelName,
      channelSlug: params.channelSlug,
    })
  ) {
    return { allowed: false, reason: "group-dm-not-allowlisted" };
  }
  if (!params.isGuildMessage) {
    return { allowed: true };
  }
  const channelAllowlistConfigured =
    Boolean(params.guildInfo?.channels) && Object.keys(params.guildInfo?.channels ?? {}).length > 0;
  const channelAllowed = params.channelConfig?.allowed !== false;
  if (
    !isDiscordGroupAllowedByPolicy({
      groupPolicy: params.groupPolicy,
      guildAllowlisted: Boolean(params.guildInfo),
      channelAllowlistConfigured,
      channelAllowed,
    })
  ) {
    return { allowed: false, reason: "guild-policy" };
  }
  if (
    shouldDenyDiscordChannelByAllowedFlag({
      groupPolicy: params.groupPolicy,
      channelConfig: params.channelConfig,
    })
  ) {
    return { allowed: false, reason: "guild-channel-denied" };
  }
  return { allowed: true };
}

async function handleDiscordReactionEvent(
  params: {
    data: DiscordReactionEvent;
    client: Client;
    action: "added" | "removed";
    cfg: LoadedConfig;
    logger: Logger;
  } & DiscordReactionRoutingParams,
) {
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
    const reactionIngressBase: Omit<DiscordReactionIngressAuthorizationParams, "channelConfig"> = {
      accountId: params.accountId,
      user,
      isDirectMessage,
      isGroupDm,
      isGuildMessage,
      channelId: data.channel_id,
      channelName,
      channelSlug,
      dmEnabled: params.dmEnabled,
      groupDmEnabled: params.groupDmEnabled,
      groupDmChannels: params.groupDmChannels,
      dmPolicy: params.dmPolicy,
      allowFrom: params.allowFrom,
      groupPolicy: params.groupPolicy,
      allowNameMatching: params.allowNameMatching,
      guildInfo,
    };
    const ingressAccess = await authorizeDiscordReactionIngress(reactionIngressBase);
    if (!ingressAccess.allowed) {
      logVerbose(`discord reaction blocked sender=${user.id} (reason=${ingressAccess.reason})`);
      return;
    }
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
        allowNameMatching: params.allowNameMatching,
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
    const authorizeReactionIngressForChannel = async (
      channelConfig: ReturnType<typeof resolveDiscordChannelConfigWithFallback>,
    ) =>
      await authorizeDiscordReactionIngress({
        ...reactionIngressBase,
        channelConfig,
      });
    const authorizeThreadChannelAccess = async (channelInfo: { parentId?: string } | null) => {
      parentId = channelInfo?.parentId;
      await loadThreadParentInfo();
      return await authorizeReactionIngressForChannel(resolveThreadChannelConfig());
    };

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
        const threadAccess = await authorizeThreadChannelAccess(channelInfo);
        if (!threadAccess.allowed) {
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
      const threadAccess = await authorizeThreadChannelAccess(channelInfo);
      if (!threadAccess.allowed) {
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
    if (isGuildMessage) {
      const channelAccess = await authorizeReactionIngressForChannel(channelConfig);
      if (!channelAccess.allowed) {
        return;
      }
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

    emitReactionWithAuthor(message);
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

type ThreadUpdateEvent = Parameters<ThreadUpdateListener["handle"]>[0];

export class DiscordThreadUpdateListener extends ThreadUpdateListener {
  constructor(
    private cfg: OpenClawConfig,
    private accountId: string,
    private logger?: Logger,
  ) {
    super();
  }

  async handle(data: ThreadUpdateEvent) {
    await runDiscordListenerWithSlowLog({
      logger: this.logger,
      listener: this.constructor.name,
      event: this.type,
      run: async () => {
        // Discord only fires THREAD_UPDATE when a field actually changes, so
        // `thread_metadata.archived === true` in this payload means the thread
        // just transitioned to the archived state.
        if (!isThreadArchived(data)) {
          return;
        }
        const threadId = "id" in data && typeof data.id === "string" ? data.id : undefined;
        if (!threadId) {
          return;
        }
        const logger = this.logger ?? discordEventQueueLog;
        logger.info("Discord thread archived — resetting session", { threadId });
        const count = await closeDiscordThreadSessions({
          cfg: this.cfg,
          accountId: this.accountId,
          threadId,
        });
        if (count > 0) {
          logger.info("Discord thread sessions reset after archival", { threadId, count });
        }
      },
      onError: (err) => {
        const logger = this.logger ?? discordEventQueueLog;
        logger.error(danger(`discord thread-update handler failed: ${String(err)}`));
      },
    });
  }
}
