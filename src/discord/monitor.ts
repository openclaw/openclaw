import {
  ChannelType,
  Client,
  Command,
  type CommandInteraction,
  type CommandOptions,
  type Guild,
  type Message,
  MessageCreateListener,
  MessageReactionAddListener,
  MessageReactionRemoveListener,
  MessageType,
  type RequestClient,
  type User,
} from "@buape/carbon";
import { GatewayIntents, GatewayPlugin } from "@buape/carbon/gateway";
import type { APIAttachment } from "discord-api-types/v10";
import { ApplicationCommandOptionType, Routes } from "discord-api-types/v10";

import {
  chunkMarkdownText,
  resolveTextChunkLimit,
} from "../auto-reply/chunk.js";
import { hasControlCommand } from "../auto-reply/command-detection.js";
import {
  buildCommandText,
  listNativeCommandSpecs,
  shouldHandleTextCommands,
} from "../auto-reply/commands-registry.js";
import { formatAgentEnvelope } from "../auto-reply/envelope.js";
import { dispatchReplyFromConfig } from "../auto-reply/reply/dispatch-from-config.js";
import {
  buildMentionRegexes,
  matchesMentionPatterns,
} from "../auto-reply/reply/mentions.js";
import {
  createReplyDispatcher,
  createReplyDispatcherWithTyping,
} from "../auto-reply/reply/reply-dispatcher.js";
import { getReplyFromConfig } from "../auto-reply/reply.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import type { ReplyToMode } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { resolveStorePath, updateLastRoute } from "../config/sessions.js";
import { danger, logVerbose, shouldLogVerbose } from "../globals.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { getChildLogger } from "../logging.js";
import { detectMime } from "../media/mime.js";
import { saveMediaBuffer } from "../media/store.js";
import {
  readProviderAllowFromStore,
  upsertProviderPairingRequest,
} from "../pairing/pairing-store.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import type { RuntimeEnv } from "../runtime.js";
import { loadWebMedia } from "../web/media.js";
import { fetchDiscordApplicationId } from "./probe.js";
import { reactMessageDiscord, sendMessageDiscord } from "./send.js";
import { normalizeDiscordToken } from "./token.js";

export type MonitorDiscordOpts = {
  token?: string;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  mediaMaxMb?: number;
  historyLimit?: number;
  replyToMode?: ReplyToMode;
};

type DiscordMediaInfo = {
  path: string;
  contentType?: string;
  placeholder: string;
};

type DiscordHistoryEntry = {
  sender: string;
  body: string;
  timestamp?: number;
  messageId?: string;
};

type DiscordReactionEvent = Parameters<MessageReactionAddListener["handle"]>[0];

export type DiscordAllowList = {
  allowAll: boolean;
  ids: Set<string>;
  names: Set<string>;
};

export type DiscordGuildEntryResolved = {
  id?: string;
  slug?: string;
  requireMention?: boolean;
  reactionNotifications?: "off" | "own" | "all" | "allowlist";
  users?: Array<string | number>;
  channels?: Record<string, { allow?: boolean; requireMention?: boolean }>;
};

export type DiscordChannelConfigResolved = {
  allowed: boolean;
  requireMention?: boolean;
};

export type DiscordMessageEvent = Parameters<
  MessageCreateListener["handle"]
>[0];

export type DiscordMessageHandler = (
  data: DiscordMessageEvent,
  client: Client,
) => Promise<void>;

export function resolveDiscordReplyTarget(opts: {
  replyToMode: ReplyToMode;
  replyToId?: string;
  hasReplied: boolean;
}): string | undefined {
  if (opts.replyToMode === "off") return undefined;
  const replyToId = opts.replyToId?.trim();
  if (!replyToId) return undefined;
  if (opts.replyToMode === "all") return replyToId;
  return opts.hasReplied ? undefined : replyToId;
}

function summarizeAllowList(list?: Array<string | number>) {
  if (!list || list.length === 0) return "any";
  const sample = list.slice(0, 4).map((entry) => String(entry));
  const suffix =
    list.length > sample.length ? ` (+${list.length - sample.length})` : "";
  return `${sample.join(", ")}${suffix}`;
}

function summarizeGuilds(entries?: Record<string, DiscordGuildEntryResolved>) {
  if (!entries || Object.keys(entries).length === 0) return "any";
  const keys = Object.keys(entries);
  const sample = keys.slice(0, 4);
  const suffix =
    keys.length > sample.length ? ` (+${keys.length - sample.length})` : "";
  return `${sample.join(", ")}${suffix}`;
}

export async function monitorDiscordProvider(opts: MonitorDiscordOpts = {}) {
  const cfg = loadConfig();
  const token = normalizeDiscordToken(
    opts.token ??
      process.env.DISCORD_BOT_TOKEN ??
      cfg.discord?.token ??
      undefined,
  );
  if (!token) {
    throw new Error(
      "DISCORD_BOT_TOKEN or discord.token is required for Discord gateway",
    );
  }

  const runtime: RuntimeEnv = opts.runtime ?? {
    log: console.log,
    error: console.error,
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  };

  const dmConfig = cfg.discord?.dm;
  const guildEntries = cfg.discord?.guilds;
  const groupPolicy = cfg.discord?.groupPolicy ?? "open";
  const allowFrom = dmConfig?.allowFrom;
  const mediaMaxBytes =
    (opts.mediaMaxMb ?? cfg.discord?.mediaMaxMb ?? 8) * 1024 * 1024;
  const textLimit = resolveTextChunkLimit(cfg, "discord");
  const historyLimit = Math.max(
    0,
    opts.historyLimit ?? cfg.discord?.historyLimit ?? 20,
  );
  const replyToMode = opts.replyToMode ?? cfg.discord?.replyToMode ?? "off";
  const dmEnabled = dmConfig?.enabled ?? true;
  const dmPolicy = dmConfig?.policy ?? "pairing";
  const groupDmEnabled = dmConfig?.groupEnabled ?? false;
  const groupDmChannels = dmConfig?.groupChannels;
  const nativeEnabled = cfg.commands?.native === true;
  const nativeDisabledExplicit = cfg.commands?.native === false;
  const useAccessGroups = cfg.commands?.useAccessGroups !== false;
  const sessionPrefix = "discord:slash";
  const ephemeralDefault = true;

  if (shouldLogVerbose()) {
    logVerbose(
      `discord: config dm=${dmEnabled ? "on" : "off"} dmPolicy=${dmPolicy} allowFrom=${summarizeAllowList(allowFrom)} groupDm=${groupDmEnabled ? "on" : "off"} groupDmChannels=${summarizeAllowList(groupDmChannels)} groupPolicy=${groupPolicy} guilds=${summarizeGuilds(guildEntries)} historyLimit=${historyLimit} mediaMaxMb=${Math.round(mediaMaxBytes / (1024 * 1024))} native=${nativeEnabled ? "on" : "off"} accessGroups=${useAccessGroups ? "on" : "off"}`,
    );
  }

  const applicationId = await fetchDiscordApplicationId(token, 4000);
  if (!applicationId) {
    throw new Error("Failed to resolve Discord application id");
  }

  const commandSpecs = nativeEnabled ? listNativeCommandSpecs() : [];
  const commands = commandSpecs.map((spec) =>
    createDiscordNativeCommand({
      command: spec,
      cfg,
      sessionPrefix,
      ephemeralDefault,
    }),
  );

  const client = new Client(
    {
      baseUrl: "http://localhost",
      deploySecret: "a",
      clientId: applicationId,
      publicKey: "a",
      token,
      autoDeploy: nativeEnabled,
    },
    {
      commands,
      listeners: [],
    },
    [
      new GatewayPlugin({
        intents:
          GatewayIntents.Guilds |
          GatewayIntents.GuildMessages |
          GatewayIntents.MessageContent |
          GatewayIntents.DirectMessages |
          GatewayIntents.GuildMessageReactions |
          GatewayIntents.DirectMessageReactions,
        autoInteractions: true,
      }),
    ],
  );

  const logger = getChildLogger({ module: "discord-auto-reply" });
  const guildHistories = new Map<string, DiscordHistoryEntry[]>();
  let botUserId: string | undefined;

  if (nativeDisabledExplicit) {
    await clearDiscordNativeCommands({
      client,
      applicationId,
      runtime,
    });
  }

  try {
    const botUser = await client.fetchUser("@me");
    botUserId = botUser?.id;
  } catch (err) {
    runtime.error?.(
      danger(`discord: failed to fetch bot identity: ${String(err)}`),
    );
  }

  const messageHandler = createDiscordMessageHandler({
    cfg,
    token,
    runtime,
    botUserId,
    guildHistories,
    historyLimit,
    mediaMaxBytes,
    textLimit,
    replyToMode,
    dmEnabled,
    groupDmEnabled,
    groupDmChannels,
    allowFrom,
    guildEntries,
  });

  client.listeners.push(new DiscordMessageListener(messageHandler));
  client.listeners.push(
    new DiscordReactionListener({
      runtime,
      botUserId,
      guildEntries,
      logger,
    }),
  );
  client.listeners.push(
    new DiscordReactionRemoveListener({
      runtime,
      botUserId,
      guildEntries,
      logger,
    }),
  );

  runtime.log?.(`logged in to discord${botUserId ? ` as ${botUserId}` : ""}`);

  await new Promise<void>((resolve) => {
    const onAbort = async () => {
      try {
        const gateway = client.getPlugin<GatewayPlugin>("gateway");
        gateway?.disconnect();
      } finally {
        resolve();
      }
    };
    opts.abortSignal?.addEventListener("abort", () => {
      void onAbort();
    });
  });
}

async function clearDiscordNativeCommands(params: {
  client: Client;
  applicationId: string;
  runtime: RuntimeEnv;
}) {
  try {
    await params.client.rest.put(
      Routes.applicationCommands(params.applicationId),
      {
        body: [],
      },
    );
    logVerbose("discord: cleared native commands (commands.native=false)");
  } catch (err) {
    params.runtime.error?.(
      danger(`discord: failed to clear native commands: ${String(err)}`),
    );
  }
}

export function createDiscordMessageHandler(params: {
  cfg: ReturnType<typeof loadConfig>;
  token: string;
  runtime: RuntimeEnv;
  botUserId?: string;
  guildHistories: Map<string, DiscordHistoryEntry[]>;
  historyLimit: number;
  mediaMaxBytes: number;
  textLimit: number;
  replyToMode: ReplyToMode;
  dmEnabled: boolean;
  groupDmEnabled: boolean;
  groupDmChannels?: Array<string | number>;
  allowFrom?: Array<string | number>;
  guildEntries?: Record<string, DiscordGuildEntryResolved>;
}): DiscordMessageHandler {
  const {
    cfg,
    token,
    runtime,
    botUserId,
    guildHistories,
    historyLimit,
    mediaMaxBytes,
    textLimit,
    replyToMode,
    dmEnabled,
    groupDmEnabled,
    groupDmChannels,
    allowFrom,
    guildEntries,
  } = params;
  const logger = getChildLogger({ module: "discord-auto-reply" });
  const mentionRegexes = buildMentionRegexes(cfg);
  const ackReaction = (cfg.messages?.ackReaction ?? "").trim();
  const ackReactionScope = cfg.messages?.ackReactionScope ?? "group-mentions";
  const groupPolicy = cfg.discord?.groupPolicy ?? "open";

  return async (data, client) => {
    try {
      const message = data.message;
      const author = data.author;
      if (!author || author.bot) return;

      const isGuildMessage = Boolean(data.guild_id);
      const channelInfo = await resolveDiscordChannelInfo(
        client,
        message.channelId,
      );
      const isDirectMessage = channelInfo?.type === ChannelType.DM;
      const isGroupDm = channelInfo?.type === ChannelType.GroupDM;

      if (isGroupDm && !groupDmEnabled) {
        logVerbose("discord: drop group dm (group dms disabled)");
        return;
      }
      if (isDirectMessage && !dmEnabled) {
        logVerbose("discord: drop dm (dms disabled)");
        return;
      }

      const dmPolicy = cfg.discord?.dm?.policy ?? "pairing";
      let commandAuthorized = true;
      if (isDirectMessage) {
        if (dmPolicy === "disabled") {
          logVerbose("discord: drop dm (dmPolicy: disabled)");
          return;
        }
        if (dmPolicy !== "open") {
          const storeAllowFrom = await readProviderAllowFromStore(
            "discord",
          ).catch(() => []);
          const effectiveAllowFrom = [...(allowFrom ?? []), ...storeAllowFrom];
          const allowList = normalizeDiscordAllowList(effectiveAllowFrom, [
            "discord:",
            "user:",
          ]);
          const permitted = allowList
            ? allowListMatches(allowList, {
                id: author.id,
                name: author.username,
                tag: formatDiscordUserTag(author),
              })
            : false;
          if (!permitted) {
            commandAuthorized = false;
            if (dmPolicy === "pairing") {
              const { code } = await upsertProviderPairingRequest({
                provider: "discord",
                id: author.id,
                meta: {
                  tag: formatDiscordUserTag(author),
                  name: author.username ?? undefined,
                },
              });
              logVerbose(
                `discord pairing request sender=${author.id} tag=${formatDiscordUserTag(author)} code=${code}`,
              );
              try {
                await sendMessageDiscord(
                  `user:${author.id}`,
                  [
                    "Clawdbot: access not configured.",
                    "",
                    `Pairing code: ${code}`,
                    "",
                    "Ask the bot owner to approve with:",
                    "clawdbot pairing approve --provider discord <code>",
                  ].join("\n"),
                  { token, rest: client.rest },
                );
              } catch (err) {
                logVerbose(
                  `discord pairing reply failed for ${author.id}: ${String(err)}`,
                );
              }
            } else {
              logVerbose(
                `Blocked unauthorized discord sender ${author.id} (dmPolicy=${dmPolicy})`,
              );
            }
            return;
          }
          commandAuthorized = true;
        }
      }
      const botId = botUserId;
      const baseText = resolveDiscordMessageText(message);
      const wasMentioned =
        !isDirectMessage &&
        (Boolean(
          botId &&
            message.mentionedUsers?.some((user: User) => user.id === botId),
        ) ||
          matchesMentionPatterns(baseText, mentionRegexes));
      if (shouldLogVerbose()) {
        logVerbose(
          `discord: inbound id=${message.id} guild=${message.guild?.id ?? "dm"} channel=${message.channelId} mention=${wasMentioned ? "yes" : "no"} type=${isDirectMessage ? "dm" : isGroupDm ? "group-dm" : "guild"} content=${baseText ? "yes" : "no"}`,
        );
      }

      if (
        isGuildMessage &&
        (message.type === MessageType.ChatInputCommand ||
          message.type === MessageType.ContextMenuCommand)
      ) {
        logVerbose("discord: drop channel command message");
        return;
      }

      const guildInfo = isGuildMessage
        ? resolveDiscordGuildEntry({
            guild: data.guild ?? undefined,
            guildEntries,
          })
        : null;
      if (
        isGuildMessage &&
        guildEntries &&
        Object.keys(guildEntries).length > 0 &&
        !guildInfo
      ) {
        logVerbose(
          `Blocked discord guild ${data.guild_id ?? "unknown"} (not in discord.guilds)`,
        );
        return;
      }

      const channelName = channelInfo?.name;
      const channelSlug = channelName ? normalizeDiscordSlug(channelName) : "";
      const guildSlug =
        guildInfo?.slug ||
        (data.guild?.name ? normalizeDiscordSlug(data.guild.name) : "");

      const route = resolveAgentRoute({
        cfg,
        provider: "discord",
        guildId: data.guild_id ?? undefined,
        peer: {
          kind: isDirectMessage ? "dm" : isGroupDm ? "group" : "channel",
          id: isDirectMessage ? author.id : message.channelId,
        },
      });
      const channelConfig = isGuildMessage
        ? resolveDiscordChannelConfig({
            guildInfo,
            channelId: message.channelId,
            channelName,
            channelSlug,
          })
        : null;

      const groupDmAllowed =
        isGroupDm &&
        resolveGroupDmAllow({
          channels: groupDmChannels,
          channelId: message.channelId,
          channelName,
          channelSlug,
        });
      if (isGroupDm && !groupDmAllowed) return;

      const channelAllowlistConfigured =
        Boolean(guildInfo?.channels) &&
        Object.keys(guildInfo?.channels ?? {}).length > 0;
      const channelAllowed = channelConfig?.allowed !== false;
      if (
        isGuildMessage &&
        !isDiscordGroupAllowedByPolicy({
          groupPolicy,
          channelAllowlistConfigured,
          channelAllowed,
        })
      ) {
        if (groupPolicy === "disabled") {
          logVerbose("discord: drop guild message (groupPolicy: disabled)");
        } else if (!channelAllowlistConfigured) {
          logVerbose(
            "discord: drop guild message (groupPolicy: allowlist, no channel allowlist)",
          );
        } else {
          logVerbose(
            `Blocked discord channel ${message.channelId} not in guild channel allowlist (groupPolicy: allowlist)`,
          );
        }
        return;
      }

      if (isGuildMessage && channelConfig?.allowed === false) {
        logVerbose(
          `Blocked discord channel ${message.channelId} not in guild channel allowlist`,
        );
        return;
      }

      const textForHistory = resolveDiscordMessageText(message);
      if (isGuildMessage && historyLimit > 0 && textForHistory) {
        const history = guildHistories.get(message.channelId) ?? [];
        history.push({
          sender:
            data.member?.nickname ??
            author.globalName ??
            author.username ??
            author.id,
          body: textForHistory,
          timestamp: resolveTimestampMs(message.timestamp),
          messageId: message.id,
        });
        while (history.length > historyLimit) history.shift();
        guildHistories.set(message.channelId, history);
      }

      const resolvedRequireMention =
        channelConfig?.requireMention ?? guildInfo?.requireMention ?? true;
      const hasAnyMention = Boolean(
        !isDirectMessage &&
          (message.mentionedEveryone ||
            (message.mentionedUsers?.length ?? 0) > 0 ||
            (message.mentionedRoles?.length ?? 0) > 0),
      );
      if (!isDirectMessage) {
        commandAuthorized = resolveDiscordCommandAuthorized({
          isDirectMessage,
          allowFrom,
          guildInfo,
          author,
        });
      }
      const allowTextCommands = shouldHandleTextCommands({
        cfg,
        surface: "discord",
      });
      const shouldBypassMention =
        allowTextCommands &&
        isGuildMessage &&
        resolvedRequireMention &&
        !wasMentioned &&
        !hasAnyMention &&
        commandAuthorized &&
        hasControlCommand(baseText);
      const canDetectMention = Boolean(botId) || mentionRegexes.length > 0;
      if (isGuildMessage && resolvedRequireMention) {
        if (botId && !wasMentioned && !shouldBypassMention) {
          logVerbose(
            `discord: drop guild message (mention required, botId=${botId})`,
          );
          logger.info(
            {
              channelId: message.channelId,
              reason: "no-mention",
            },
            "discord: skipping guild message",
          );
          return;
        }
      }

      if (isGuildMessage) {
        const userAllow = guildInfo?.users;
        if (Array.isArray(userAllow) && userAllow.length > 0) {
          const users = normalizeDiscordAllowList(userAllow, [
            "discord:",
            "user:",
          ]);
          const userOk =
            !users ||
            allowListMatches(users, {
              id: author.id,
              name: author.username,
              tag: formatDiscordUserTag(author),
            });
          if (!userOk) {
            logVerbose(
              `Blocked discord guild sender ${author.id} (not in guild users allowlist)`,
            );
            return;
          }
        }
      }

      const systemLocation = resolveDiscordSystemLocation({
        isDirectMessage,
        isGroupDm,
        guild: data.guild ?? undefined,
        channelName: channelName ?? message.channelId,
      });
      const systemText = resolveDiscordSystemEvent(message, systemLocation);
      if (systemText) {
        enqueueSystemEvent(systemText, {
          sessionKey: route.sessionKey,
          contextKey: `discord:system:${message.channelId}:${message.id}`,
        });
        return;
      }

      const media = await resolveMedia(message, mediaMaxBytes);
      const text =
        message.content?.trim() ??
        media?.placeholder ??
        message.embeds?.[0]?.description ??
        "";
      if (!text) {
        logVerbose(`discord: drop message ${message.id} (empty content)`);
        return;
      }
      const shouldAckReaction = () => {
        if (!ackReaction) return false;
        if (ackReactionScope === "all") return true;
        if (ackReactionScope === "direct") return isDirectMessage;
        const isGroupChat = isGuildMessage || isGroupDm;
        if (ackReactionScope === "group-all") return isGroupChat;
        if (ackReactionScope === "group-mentions") {
          if (!isGuildMessage) return false;
          if (!resolvedRequireMention) return false;
          if (!canDetectMention) return false;
          return wasMentioned || shouldBypassMention;
        }
        return false;
      };
      if (shouldAckReaction()) {
        reactMessageDiscord(message.channelId, message.id, ackReaction, {
          rest: client.rest,
        }).catch((err) => {
          logVerbose(
            `discord react failed for channel ${message.channelId}: ${String(err)}`,
          );
        });
      }

      const fromLabel = isDirectMessage
        ? buildDirectLabel(author)
        : buildGuildLabel({
            guild: data.guild ?? undefined,
            channelName: channelName ?? message.channelId,
            channelId: message.channelId,
          });
      const groupRoom =
        isGuildMessage && channelSlug ? `#${channelSlug}` : undefined;
      const groupSubject = isDirectMessage ? undefined : groupRoom;
      let combinedBody = formatAgentEnvelope({
        provider: "Discord",
        from: fromLabel,
        timestamp: resolveTimestampMs(message.timestamp),
        body: text,
      });
      let shouldClearHistory = false;
      if (!isDirectMessage) {
        const history =
          historyLimit > 0 ? (guildHistories.get(message.channelId) ?? []) : [];
        const historyWithoutCurrent =
          history.length > 0 ? history.slice(0, -1) : [];
        if (historyWithoutCurrent.length > 0) {
          const historyText = historyWithoutCurrent
            .map((entry) =>
              formatAgentEnvelope({
                provider: "Discord",
                from: fromLabel,
                timestamp: entry.timestamp,
                body: `${entry.sender}: ${entry.body} [id:${entry.messageId ?? "unknown"} channel:${message.channelId}]`,
              }),
            )
            .join("\n");
          combinedBody = `[Chat messages since your last reply - for context]\n${historyText}\n\n[Current message - respond to this]\n${combinedBody}`;
        }
        const name = formatDiscordUserTag(author);
        const id = author.id;
        combinedBody = `${combinedBody}\n[from: ${name} user id:${id}]`;
        shouldClearHistory = true;
      }
      const replyContext = resolveReplyContext(message);
      if (replyContext) {
        combinedBody = `[Replied message - for context]\n${replyContext}\n\n${combinedBody}`;
      }

      const ctxPayload = {
        Body: combinedBody,
        From: isDirectMessage
          ? `discord:${author.id}`
          : `group:${message.channelId}`,
        To: isDirectMessage
          ? `user:${author.id}`
          : `channel:${message.channelId}`,
        SessionKey: route.sessionKey,
        AccountId: route.accountId,
        ChatType: isDirectMessage ? "direct" : "group",
        SenderName:
          data.member?.nickname ?? author.globalName ?? author.username,
        SenderId: author.id,
        SenderUsername: author.username,
        SenderTag: formatDiscordUserTag(author),
        GroupSubject: groupSubject,
        GroupRoom: groupRoom,
        GroupSpace: isGuildMessage
          ? (guildInfo?.id ?? guildSlug) || undefined
          : undefined,
        Provider: "discord" as const,
        Surface: "discord" as const,
        WasMentioned: wasMentioned,
        MessageSid: message.id,
        Timestamp: resolveTimestampMs(message.timestamp),
        MediaPath: media?.path,
        MediaType: media?.contentType,
        MediaUrl: media?.path,
        CommandAuthorized: commandAuthorized,
        CommandSource: "text" as const,
      };
      const replyTarget = ctxPayload.To ?? undefined;
      if (!replyTarget) {
        runtime.error?.(danger("discord: missing reply target"));
        return;
      }

      if (isDirectMessage) {
        const sessionCfg = cfg.session;
        const storePath = resolveStorePath(sessionCfg?.store, {
          agentId: route.agentId,
        });
        await updateLastRoute({
          storePath,
          sessionKey: route.mainSessionKey,
          provider: "discord",
          to: `user:${author.id}`,
          accountId: route.accountId,
        });
      }

      if (shouldLogVerbose()) {
        const preview = combinedBody.slice(0, 200).replace(/\n/g, "\\n");
        logVerbose(
          `discord inbound: channel=${message.channelId} from=${ctxPayload.From} preview="${preview}"`,
        );
      }

      let didSendReply = false;
      const { dispatcher, replyOptions, markDispatchIdle } =
        createReplyDispatcherWithTyping({
          responsePrefix: cfg.messages?.responsePrefix,
          deliver: async (payload) => {
            await deliverDiscordReply({
              replies: [payload],
              target: replyTarget,
              token,
              rest: client.rest,
              runtime,
              replyToMode,
              textLimit,
            });
            didSendReply = true;
          },
          onError: (err, info) => {
            runtime.error?.(
              danger(`discord ${info.kind} reply failed: ${String(err)}`),
            );
          },
          onReplyStart: () => sendTyping(message),
        });

      const { queuedFinal, counts } = await dispatchReplyFromConfig({
        ctx: ctxPayload,
        cfg,
        dispatcher,
        replyOptions,
      });
      markDispatchIdle();
      if (!queuedFinal) {
        if (
          isGuildMessage &&
          shouldClearHistory &&
          historyLimit > 0 &&
          didSendReply
        ) {
          guildHistories.set(message.channelId, []);
        }
        return;
      }
      didSendReply = true;
      if (shouldLogVerbose()) {
        const finalCount = counts.final;
        logVerbose(
          `discord: delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${replyTarget}`,
        );
      }
      if (
        isGuildMessage &&
        shouldClearHistory &&
        historyLimit > 0 &&
        didSendReply
      ) {
        guildHistories.set(message.channelId, []);
      }
    } catch (err) {
      runtime.error?.(danger(`handler failed: ${String(err)}`));
    }
  };
}

class DiscordMessageListener extends MessageCreateListener {
  constructor(private handler: DiscordMessageHandler) {
    super();
  }

  async handle(data: DiscordMessageEvent, client: Client) {
    await this.handler(data, client);
  }
}

class DiscordReactionListener extends MessageReactionAddListener {
  constructor(
    private params: {
      runtime: RuntimeEnv;
      botUserId?: string;
      guildEntries?: Record<string, DiscordGuildEntryResolved>;
      logger: ReturnType<typeof getChildLogger>;
    },
  ) {
    super();
  }

  async handle(data: DiscordReactionEvent, client: Client) {
    await handleDiscordReactionEvent({
      data,
      client,
      action: "added",
      botUserId: this.params.botUserId,
      guildEntries: this.params.guildEntries,
      logger: this.params.logger,
    });
  }
}

class DiscordReactionRemoveListener extends MessageReactionRemoveListener {
  constructor(
    private params: {
      runtime: RuntimeEnv;
      botUserId?: string;
      guildEntries?: Record<string, DiscordGuildEntryResolved>;
      logger: ReturnType<typeof getChildLogger>;
    },
  ) {
    super();
  }

  async handle(data: DiscordReactionEvent, client: Client) {
    await handleDiscordReactionEvent({
      data,
      client,
      action: "removed",
      botUserId: this.params.botUserId,
      guildEntries: this.params.guildEntries,
      logger: this.params.logger,
    });
  }
}

async function handleDiscordReactionEvent(params: {
  data: DiscordReactionEvent;
  client: Client;
  action: "added" | "removed";
  botUserId?: string;
  guildEntries?: Record<string, DiscordGuildEntryResolved>;
  logger: ReturnType<typeof getChildLogger>;
}) {
  try {
    const { data, client, action, botUserId, guildEntries } = params;
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
    const channelName =
      "name" in channel ? (channel.name ?? undefined) : undefined;
    const channelSlug = channelName ? normalizeDiscordSlug(channelName) : "";
    const channelConfig = resolveDiscordChannelConfig({
      guildInfo,
      channelId: data.channel_id,
      channelName,
      channelSlug,
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
      guildInfo?.slug ||
      (data.guild?.name
        ? normalizeDiscordSlug(data.guild.name)
        : data.guild_id);
    const channelLabel = channelSlug
      ? `#${channelSlug}`
      : channelName
        ? `#${normalizeDiscordSlug(channelName)}`
        : `#${data.channel_id}`;
    const authorLabel = message?.author
      ? formatDiscordUserTag(message.author)
      : undefined;
    const baseText = `Discord reaction ${action}: ${emojiLabel} by ${actorLabel} on ${guildSlug} ${channelLabel} msg ${data.message_id}`;
    const text = authorLabel ? `${baseText} from ${authorLabel}` : baseText;
    const cfg = loadConfig();
    const route = resolveAgentRoute({
      cfg,
      provider: "discord",
      guildId: data.guild_id ?? undefined,
      peer: { kind: "channel", id: data.channel_id },
    });
    enqueueSystemEvent(text, {
      sessionKey: route.sessionKey,
      contextKey: `discord:reaction:${action}:${data.message_id}:${user.id}:${emojiLabel}`,
    });
  } catch (err) {
    params.logger.error(
      danger(`discord reaction handler failed: ${String(err)}`),
    );
  }
}

function createDiscordNativeCommand(params: {
  command: {
    name: string;
    description: string;
    acceptsArgs: boolean;
  };
  cfg: ReturnType<typeof loadConfig>;
  sessionPrefix: string;
  ephemeralDefault: boolean;
}) {
  const { command, cfg, sessionPrefix, ephemeralDefault } = params;
  return new (class extends Command {
    name = command.name;
    description = command.description;
    defer = true;
    ephemeral = ephemeralDefault;
    options = command.acceptsArgs
      ? ([
          {
            name: "input",
            description: "Command input",
            type: ApplicationCommandOptionType.String,
            required: false,
          },
        ] satisfies CommandOptions)
      : undefined;

    async run(interaction: CommandInteraction) {
      const useAccessGroups = cfg.commands?.useAccessGroups !== false;
      const user = interaction.user;
      if (!user) return;
      const channel = interaction.channel;
      const channelType = channel?.type;
      const isDirectMessage = channelType === ChannelType.DM;
      const isGroupDm = channelType === ChannelType.GroupDM;
      const channelName =
        channel && "name" in channel ? (channel.name as string) : undefined;
      const channelSlug = channelName ? normalizeDiscordSlug(channelName) : "";
      const prompt = buildCommandText(
        this.name,
        command.acceptsArgs
          ? interaction.options.getString("input")
          : undefined,
      );
      const guildInfo = resolveDiscordGuildEntry({
        guild: interaction.guild ?? undefined,
        guildEntries: cfg.discord?.guilds,
      });
      if (useAccessGroups && interaction.guild) {
        const channelConfig = resolveDiscordChannelConfig({
          guildInfo,
          channelId: channel?.id ?? "",
          channelName,
          channelSlug,
        });
        const channelAllowlistConfigured =
          Boolean(guildInfo?.channels) &&
          Object.keys(guildInfo?.channels ?? {}).length > 0;
        const channelAllowed = channelConfig?.allowed !== false;
        const allowByPolicy = isDiscordGroupAllowedByPolicy({
          groupPolicy: cfg.discord?.groupPolicy ?? "open",
          channelAllowlistConfigured,
          channelAllowed,
        });
        if (!allowByPolicy) {
          await interaction.reply({
            content: "This channel is not allowed.",
          });
          return;
        }
      }
      const dmEnabled = cfg.discord?.dm?.enabled ?? true;
      const dmPolicy = cfg.discord?.dm?.policy ?? "pairing";
      let commandAuthorized = true;
      if (isDirectMessage) {
        if (!dmEnabled || dmPolicy === "disabled") {
          await interaction.reply({ content: "Discord DMs are disabled." });
          return;
        }
        if (dmPolicy !== "open") {
          const storeAllowFrom = await readProviderAllowFromStore(
            "discord",
          ).catch(() => []);
          const effectiveAllowFrom = [
            ...(cfg.discord?.dm?.allowFrom ?? []),
            ...storeAllowFrom,
          ];
          const allowList = normalizeDiscordAllowList(effectiveAllowFrom, [
            "discord:",
            "user:",
          ]);
          const permitted = allowList
            ? allowListMatches(allowList, {
                id: user.id,
                name: user.username,
                tag: formatDiscordUserTag(user),
              })
            : false;
          if (!permitted) {
            commandAuthorized = false;
            if (dmPolicy === "pairing") {
              const { code } = await upsertProviderPairingRequest({
                provider: "discord",
                id: user.id,
                meta: {
                  tag: formatDiscordUserTag(user),
                  name: user.username ?? undefined,
                },
              });
              await interaction.reply({
                content: [
                  "Clawdbot: access not configured.",
                  "",
                  `Pairing code: ${code}`,
                  "",
                  "Ask the bot owner to approve with:",
                  "clawdbot pairing approve --provider discord <code>",
                ].join("\n"),
                ephemeral: true,
              });
            } else {
              await interaction.reply({
                content: "You are not authorized to use this command.",
                ephemeral: true,
              });
            }
            return;
          }
          commandAuthorized = true;
        }
      }
      if (guildInfo?.users && !isDirectMessage) {
        const allowList = normalizeDiscordAllowList(guildInfo.users, [
          "discord:",
          "user:",
        ]);
        if (
          allowList &&
          !allowListMatches(allowList, {
            id: user.id,
            name: user.username,
            tag: formatDiscordUserTag(user),
          })
        ) {
          await interaction.reply({
            content: "You are not authorized to use this command.",
          });
          return;
        }
      }
      if (isGroupDm && cfg.discord?.dm?.groupEnabled === false) {
        await interaction.reply({ content: "Discord group DMs are disabled." });
        return;
      }

      const isGuild = Boolean(interaction.guild);
      const channelId = channel?.id ?? "unknown";
      const interactionId = interaction.rawData.id;
      const route = resolveAgentRoute({
        cfg,
        provider: "discord",
        guildId: interaction.guild?.id ?? undefined,
        peer: {
          kind: isDirectMessage ? "dm" : isGroupDm ? "group" : "channel",
          id: isDirectMessage ? user.id : channelId,
        },
      });
      const ctxPayload = {
        Body: prompt,
        From: isDirectMessage ? `discord:${user.id}` : `group:${channelId}`,
        To: `slash:${user.id}`,
        SessionKey: `agent:${route.agentId}:${sessionPrefix}:${user.id}`,
        AccountId: route.accountId,
        ChatType: isDirectMessage ? "direct" : "group",
        GroupSubject: isGuild ? interaction.guild?.name : undefined,
        SenderName: user.globalName ?? user.username,
        SenderId: user.id,
        SenderUsername: user.username,
        SenderTag: formatDiscordUserTag(user),
        Provider: "discord" as const,
        Surface: "discord" as const,
        WasMentioned: true,
        MessageSid: interactionId,
        Timestamp: Date.now(),
        CommandAuthorized: commandAuthorized,
        CommandSource: "native" as const,
      };

      let didReply = false;
      const dispatcher = createReplyDispatcher({
        responsePrefix: cfg.messages?.responsePrefix,
        deliver: async (payload, _info) => {
          await deliverDiscordInteractionReply({
            interaction,
            payload,
            textLimit: resolveTextChunkLimit(cfg, "discord"),
            preferFollowUp: didReply,
          });
          didReply = true;
        },
        onError: (err) => {
          console.error(err);
        },
      });

      const replyResult = await getReplyFromConfig(ctxPayload, undefined, cfg);
      const replies = replyResult
        ? Array.isArray(replyResult)
          ? replyResult
          : [replyResult]
        : [];
      for (const reply of replies) {
        dispatcher.sendFinalReply(reply);
      }
      await dispatcher.waitForIdle();
    }
  })();
}

async function deliverDiscordInteractionReply(params: {
  interaction: CommandInteraction;
  payload: ReplyPayload;
  textLimit: number;
  preferFollowUp: boolean;
}) {
  const { interaction, payload, textLimit, preferFollowUp } = params;
  const mediaList =
    payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
  const text = payload.text ?? "";

  const sendMessage = async (
    content: string,
    files?: { name: string; data: Buffer }[],
  ) => {
    const payload =
      files && files.length > 0
        ? {
            content,
            files: files.map((file) => {
              if (file.data instanceof Blob) {
                return { name: file.name, data: file.data };
              }
              const arrayBuffer = Uint8Array.from(file.data).buffer;
              return { name: file.name, data: new Blob([arrayBuffer]) };
            }),
          }
        : { content };
    if (!preferFollowUp) {
      await interaction.reply(payload);
      return;
    }
    await interaction.followUp(payload);
  };

  if (mediaList.length > 0) {
    const media = await Promise.all(
      mediaList.map(async (url) => {
        const loaded = await loadWebMedia(url);
        return {
          name: loaded.fileName ?? "upload",
          data: loaded.buffer,
        };
      }),
    );
    const caption = text.length > textLimit ? text.slice(0, textLimit) : text;
    await sendMessage(caption, media);
    if (text.length > textLimit) {
      const remaining = text.slice(textLimit).trim();
      if (remaining) {
        for (const chunk of chunkMarkdownText(remaining, textLimit)) {
          await interaction.followUp({ content: chunk });
        }
      }
    }
    return;
  }

  if (!text.trim()) return;
  for (const chunk of chunkMarkdownText(text, textLimit)) {
    await sendMessage(chunk);
  }
}

async function deliverDiscordReply(params: {
  replies: ReplyPayload[];
  target: string;
  token: string;
  rest?: RequestClient;
  runtime: RuntimeEnv;
  textLimit: number;
  replyToMode: ReplyToMode;
}) {
  const chunkLimit = Math.min(params.textLimit, 2000);
  for (const payload of params.replies) {
    const mediaList =
      payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
    const text = payload.text ?? "";
    if (!text && mediaList.length === 0) continue;

    if (mediaList.length === 0) {
      for (const chunk of chunkMarkdownText(text, chunkLimit)) {
        const trimmed = chunk.trim();
        if (!trimmed) continue;
        await sendMessageDiscord(params.target, trimmed, {
          token: params.token,
          rest: params.rest,
        });
      }
      continue;
    }

    const firstMedia = mediaList[0];
    if (!firstMedia) continue;
    await sendMessageDiscord(params.target, text, {
      token: params.token,
      rest: params.rest,
      mediaUrl: firstMedia,
    });
    for (const extra of mediaList.slice(1)) {
      await sendMessageDiscord(params.target, "", {
        token: params.token,
        rest: params.rest,
        mediaUrl: extra,
      });
    }
  }
}

async function resolveDiscordChannelInfo(
  client: Client,
  channelId: string,
): Promise<{ type: ChannelType; name?: string } | null> {
  try {
    const channel = await client.fetchChannel(channelId);
    if (!channel) return null;
    const name = "name" in channel ? (channel.name ?? undefined) : undefined;
    return { type: channel.type, name };
  } catch (err) {
    logVerbose(`discord: failed to fetch channel ${channelId}: ${String(err)}`);
    return null;
  }
}

async function resolveMedia(
  message: Message,
  maxBytes: number,
): Promise<DiscordMediaInfo | null> {
  const attachment = message.attachments?.[0];
  if (!attachment) return null;
  const res = await fetch(attachment.url);
  if (!res.ok) {
    throw new Error(
      `Failed to download discord attachment: HTTP ${res.status}`,
    );
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const mime = await detectMime({
    buffer,
    headerMime: attachment.content_type ?? res.headers.get("content-type"),
    filePath: attachment.filename ?? attachment.url,
  });
  const saved = await saveMediaBuffer(buffer, mime, "inbound", maxBytes);
  return {
    path: saved.path,
    contentType: saved.contentType,
    placeholder: inferPlaceholder(attachment),
  };
}

function inferPlaceholder(attachment: APIAttachment): string {
  const mime = attachment.content_type ?? "";
  if (mime.startsWith("image/")) return "<media:image>";
  if (mime.startsWith("video/")) return "<media:video>";
  if (mime.startsWith("audio/")) return "<media:audio>";
  return "<media:document>";
}

function resolveDiscordMessageText(
  message: Message,
  fallbackText?: string,
): string {
  const attachment = message.attachments?.[0];
  return (
    message.content?.trim() ||
    (attachment ? inferPlaceholder(attachment) : "") ||
    message.embeds?.[0]?.description ||
    fallbackText?.trim() ||
    ""
  );
}

function resolveReplyContext(message: Message): string | null {
  const referenced = message.referencedMessage;
  if (!referenced?.author) return null;
  const referencedText = resolveDiscordMessageText(referenced);
  if (!referencedText) return null;
  const fromLabel = referenced.author
    ? buildDirectLabel(referenced.author)
    : "Unknown";
  const body = `${referencedText}\n[discord message id: ${referenced.id} channel: ${referenced.channelId} from: ${formatDiscordUserTag(referenced.author)} user id:${referenced.author?.id ?? "unknown"}]`;
  return formatAgentEnvelope({
    provider: "Discord",
    from: fromLabel,
    timestamp: resolveTimestampMs(referenced.timestamp),
    body,
  });
}

function buildDirectLabel(author: User) {
  const username = formatDiscordUserTag(author);
  return `${username} user id:${author.id}`;
}

function buildGuildLabel(params: {
  guild?: Guild;
  channelName: string;
  channelId: string;
}) {
  const { guild, channelName, channelId } = params;
  return `${guild?.name ?? "Guild"} #${channelName} channel id:${channelId}`;
}

function resolveDiscordSystemEvent(
  message: Message,
  location: string,
): string | null {
  switch (message.type) {
    case MessageType.ChannelPinnedMessage:
      return buildDiscordSystemEvent(message, location, "pinned a message");
    case MessageType.RecipientAdd:
      return buildDiscordSystemEvent(message, location, "added a recipient");
    case MessageType.RecipientRemove:
      return buildDiscordSystemEvent(message, location, "removed a recipient");
    case MessageType.UserJoin:
      return buildDiscordSystemEvent(message, location, "user joined");
    case MessageType.GuildBoost:
      return buildDiscordSystemEvent(message, location, "boosted the server");
    case MessageType.GuildBoostTier1:
      return buildDiscordSystemEvent(
        message,
        location,
        "boosted the server (Tier 1 reached)",
      );
    case MessageType.GuildBoostTier2:
      return buildDiscordSystemEvent(
        message,
        location,
        "boosted the server (Tier 2 reached)",
      );
    case MessageType.GuildBoostTier3:
      return buildDiscordSystemEvent(
        message,
        location,
        "boosted the server (Tier 3 reached)",
      );
    case MessageType.ThreadCreated:
      return buildDiscordSystemEvent(message, location, "created a thread");
    case MessageType.AutoModerationAction:
      return buildDiscordSystemEvent(
        message,
        location,
        "auto moderation action",
      );
    case MessageType.GuildIncidentAlertModeEnabled:
      return buildDiscordSystemEvent(
        message,
        location,
        "raid protection enabled",
      );
    case MessageType.GuildIncidentAlertModeDisabled:
      return buildDiscordSystemEvent(
        message,
        location,
        "raid protection disabled",
      );
    case MessageType.GuildIncidentReportRaid:
      return buildDiscordSystemEvent(message, location, "raid reported");
    case MessageType.GuildIncidentReportFalseAlarm:
      return buildDiscordSystemEvent(
        message,
        location,
        "raid report marked false alarm",
      );
    case MessageType.StageStart:
      return buildDiscordSystemEvent(message, location, "stage started");
    case MessageType.StageEnd:
      return buildDiscordSystemEvent(message, location, "stage ended");
    case MessageType.StageSpeaker:
      return buildDiscordSystemEvent(
        message,
        location,
        "stage speaker updated",
      );
    case MessageType.StageTopic:
      return buildDiscordSystemEvent(message, location, "stage topic updated");
    case MessageType.PollResult:
      return buildDiscordSystemEvent(message, location, "poll results posted");
    case MessageType.PurchaseNotification:
      return buildDiscordSystemEvent(
        message,
        location,
        "purchase notification",
      );
    default:
      return null;
  }
}

function buildDiscordSystemEvent(
  message: Message,
  location: string,
  action: string,
) {
  const authorLabel = message.author
    ? formatDiscordUserTag(message.author)
    : "";
  const actor = authorLabel ? `${authorLabel} ` : "";
  return `Discord system: ${actor}${action} in ${location}`;
}

function resolveDiscordSystemLocation(params: {
  isDirectMessage: boolean;
  isGroupDm: boolean;
  guild?: Guild;
  channelName: string;
}) {
  const { isDirectMessage, isGroupDm, guild, channelName } = params;
  if (isDirectMessage) return "DM";
  if (isGroupDm) return `Group DM #${channelName}`;
  return guild?.name ? `${guild.name} #${channelName}` : `#${channelName}`;
}

function formatDiscordReactionEmoji(emoji: {
  id?: string | null;
  name?: string | null;
}) {
  if (emoji.id && emoji.name) {
    return `${emoji.name}:${emoji.id}`;
  }
  return emoji.name ?? "emoji";
}

function formatDiscordUserTag(user: User) {
  const discriminator = (user.discriminator ?? "").trim();
  if (discriminator && discriminator !== "0") {
    return `${user.username}#${discriminator}`;
  }
  return user.username ?? user.id;
}

function resolveTimestampMs(timestamp?: string | null) {
  if (!timestamp) return undefined;
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function normalizeDiscordAllowList(
  raw: Array<string | number> | undefined,
  prefixes: string[],
) {
  if (!raw || raw.length === 0) return null;
  const ids = new Set<string>();
  const names = new Set<string>();
  const allowAll = raw.some((entry) => String(entry).trim() === "*");
  for (const entry of raw) {
    const text = String(entry).trim();
    if (!text || text === "*") continue;
    const normalized = normalizeDiscordSlug(text);
    const maybeId = text.replace(/^<@!?/, "").replace(/>$/, "");
    if (/^\d+$/.test(maybeId)) {
      ids.add(maybeId);
      continue;
    }
    const prefix = prefixes.find((entry) => text.startsWith(entry));
    if (prefix) {
      const candidate = text.slice(prefix.length);
      if (candidate) ids.add(candidate);
      continue;
    }
    if (normalized) {
      names.add(normalized);
    }
  }
  return { allowAll, ids, names } satisfies DiscordAllowList;
}

export function normalizeDiscordSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/^#/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function allowListMatches(
  list: DiscordAllowList,
  candidate: { id?: string; name?: string; tag?: string },
) {
  if (list.allowAll) return true;
  if (candidate.id && list.ids.has(candidate.id)) return true;
  const slug = candidate.name ? normalizeDiscordSlug(candidate.name) : "";
  if (slug && list.names.has(slug)) return true;
  if (candidate.tag && list.names.has(normalizeDiscordSlug(candidate.tag)))
    return true;
  return false;
}

export function resolveDiscordCommandAuthorized(params: {
  isDirectMessage: boolean;
  allowFrom?: Array<string | number>;
  guildInfo?: DiscordGuildEntryResolved | null;
  author: User;
}) {
  if (!params.isDirectMessage) return true;
  const allowList = normalizeDiscordAllowList(params.allowFrom, [
    "discord:",
    "user:",
  ]);
  if (!allowList) return true;
  return allowListMatches(allowList, {
    id: params.author.id,
    name: params.author.username,
    tag: formatDiscordUserTag(params.author),
  });
}

export function resolveDiscordGuildEntry(params: {
  guild?: Guild<true> | Guild<false> | null;
  guildEntries?: Record<string, DiscordGuildEntryResolved>;
}): DiscordGuildEntryResolved | null {
  const guild = params.guild;
  const entries = params.guildEntries;
  if (!guild || !entries) return null;
  const byId = entries[guild.id];
  if (byId) return { ...byId, id: guild.id };
  const slug = normalizeDiscordSlug(guild.name ?? "");
  const bySlug = entries[slug];
  if (bySlug) return { ...bySlug, id: guild.id, slug: slug || bySlug.slug };
  const wildcard = entries["*"];
  if (wildcard)
    return { ...wildcard, id: guild.id, slug: slug || wildcard.slug };
  return null;
}

export function resolveDiscordChannelConfig(params: {
  guildInfo?: DiscordGuildEntryResolved | null;
  channelId: string;
  channelName?: string;
  channelSlug: string;
}): DiscordChannelConfigResolved | null {
  const { guildInfo, channelId, channelName, channelSlug } = params;
  const channels = guildInfo?.channels;
  if (!channels) return null;
  const byId = channels[channelId];
  if (byId)
    return {
      allowed: byId.allow !== false,
      requireMention: byId.requireMention,
    };
  if (channelSlug && channels[channelSlug]) {
    const entry = channels[channelSlug];
    return {
      allowed: entry.allow !== false,
      requireMention: entry.requireMention,
    };
  }
  if (channelName && channels[channelName]) {
    const entry = channels[channelName];
    return {
      allowed: entry.allow !== false,
      requireMention: entry.requireMention,
    };
  }
  return { allowed: false };
}

export function isDiscordGroupAllowedByPolicy(params: {
  groupPolicy: "open" | "disabled" | "allowlist";
  channelAllowlistConfigured: boolean;
  channelAllowed: boolean;
}): boolean {
  const { groupPolicy, channelAllowlistConfigured, channelAllowed } = params;
  if (groupPolicy === "disabled") return false;
  if (groupPolicy === "open") return true;
  if (!channelAllowlistConfigured) return false;
  return channelAllowed;
}

export function resolveGroupDmAllow(params: {
  channels?: Array<string | number>;
  channelId: string;
  channelName?: string;
  channelSlug: string;
}) {
  const { channels, channelId, channelName, channelSlug } = params;
  if (!channels || channels.length === 0) return true;
  const allowList = channels.map((entry) =>
    normalizeDiscordSlug(String(entry)),
  );
  const candidates = [
    normalizeDiscordSlug(channelId),
    channelSlug,
    channelName ? normalizeDiscordSlug(channelName) : "",
  ].filter(Boolean);
  return (
    allowList.includes("*") ||
    candidates.some((candidate) => allowList.includes(candidate))
  );
}

export function shouldEmitDiscordReactionNotification(params: {
  mode?: "off" | "own" | "all" | "allowlist";
  botId?: string;
  messageAuthorId?: string;
  userId: string;
  userName?: string;
  userTag?: string;
  allowlist?: Array<string | number>;
}) {
  const mode = params.mode ?? "own";
  if (mode === "off") return false;
  if (mode === "all") return true;
  if (mode === "own") {
    return Boolean(params.botId && params.messageAuthorId === params.botId);
  }
  if (mode === "allowlist") {
    const list = normalizeDiscordAllowList(params.allowlist, [
      "discord:",
      "user:",
    ]);
    if (!list) return false;
    return allowListMatches(list, {
      id: params.userId,
      name: params.userName,
      tag: params.userTag,
    });
  }
  return false;
}

async function sendTyping(params: { client: Client; channelId: string }) {
  try {
    const channel = await params.client.fetchChannel(params.channelId);
    if (!channel) return;
    if (
      "triggerTyping" in channel &&
      typeof channel.triggerTyping === "function"
    ) {
      await channel.triggerTyping();
    }
  } catch (err) {
    logVerbose(
      `discord typing cue failed for channel ${params.channelId}: ${String(err)}`,
    );
  }
}
