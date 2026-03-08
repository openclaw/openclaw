import { ChannelType, MessageType, type User } from "@buape/carbon";
import {
  ensureConfiguredAcpRouteReady,
  resolveConfiguredAcpRoute,
} from "../../acp/persistent-bindings.route.js";
import { hasControlCommand } from "../../auto-reply/command-detection.js";
import { shouldHandleTextCommands } from "../../auto-reply/commands-registry.js";
import {
  recordPendingHistoryEntryIfEnabled,
  type HistoryEntry,
} from "../../auto-reply/reply/history.js";
import {
  buildMentionRegexes,
  matchesMentionWithExplicit,
} from "../../auto-reply/reply/mentions.js";
import { formatAllowlistMatchMeta } from "../../channels/allowlist-match.js";
import { resolveControlCommandGate } from "../../channels/command-gating.js";
import { logInboundDrop } from "../../channels/logging.js";
import { resolveMentionGatingWithBypass } from "../../channels/mention-gating.js";
import { loadConfig } from "../../config/config.js";
import { isDangerousNameMatchingEnabled } from "../../config/dangerous-name-matching.js";
import { logVerbose, shouldLogVerbose } from "../../globals.js";
import { recordChannelActivity } from "../../infra/channel-activity.js";
import {
  getSessionBindingService,
  type SessionBindingRecord,
} from "../../infra/outbound/session-binding-service.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { logDebug } from "../../logger.js";
import { buildPairingReply } from "../../pairing/pairing-messages.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import { markMentionResponded } from "../a2a-retry/index.js";
import { checkA2ARateLimit } from "../loop-guard.js";
import { fetchPluralKitMessageInfo } from "../pluralkit.js";
import { sendMessageDiscord } from "../send.js";
import {
  isDiscordGroupAllowedByPolicy,
  normalizeDiscordSlug,
  resolveDiscordChannelConfigWithFallback,
  resolveDiscordGuildEntry,
  resolveDiscordMemberAllowed,
  resolveDiscordOwnerAccess,
  resolveDiscordShouldRequireMention,
  resolveGroupDmAllow,
} from "./allow-list.js";
import { resolveDiscordDmCommandAccess } from "./dm-command-auth.js";
import { handleDiscordDmCommandDecision } from "./dm-command-decision.js";
import {
  formatDiscordUserTag,
  resolveDiscordSystemLocation,
  resolveTimestampMs,
} from "./format.js";
import type {
  DiscordMessagePreflightContext,
  DiscordMessagePreflightParams,
} from "./message-handler.preflight.types.js";
import {
  resolveDiscordChannelInfo,
  resolveDiscordMessageChannelId,
  resolveDiscordMessageText,
} from "./message-utils.js";
import { resolveDiscordPreflightAudioMentionContext } from "./preflight-audio.js";
import {
  buildDiscordRoutePeer,
  resolveDiscordConversationRoute,
  resolveDiscordEffectiveRoute,
} from "./route-resolution.js";
import { resolveDiscordSenderIdentity, resolveDiscordWebhookId } from "./sender-identity.js";
import { isSiblingBot, getAgentIdForBot } from "./sibling-bots.js";
import { resolveDiscordSystemEvent } from "./system-events.js";
import { isRecentlyUnboundThreadWebhookMessage } from "./thread-bindings.js";
import {
  isThreadParticipant,
  registerThreadParticipant,
  touchThreadActivity,
} from "./thread-participants.js";
import { resolveDiscordThreadChannel, resolveDiscordThreadParentInfo } from "./threading.js";

export type {
  DiscordMessagePreflightContext,
  DiscordMessagePreflightParams,
} from "./message-handler.preflight.types.js";

const DISCORD_BOUND_THREAD_SYSTEM_PREFIXES = ["⚙️", "🤖", "🧰"];

function isPreflightAborted(abortSignal?: AbortSignal): boolean {
  return Boolean(abortSignal?.aborted);
}

function isBoundThreadBotSystemMessage(params: {
  isBoundThreadSession: boolean;
  isBotAuthor: boolean;
  text?: string;
}): boolean {
  if (!params.isBoundThreadSession || !params.isBotAuthor) {
    return false;
  }
  const text = params.text?.trim();
  if (!text) {
    return false;
  }
  return DISCORD_BOUND_THREAD_SYSTEM_PREFIXES.some((prefix) => text.startsWith(prefix));
}

export function resolvePreflightMentionRequirement(params: {
  shouldRequireMention: boolean;
  isBoundThreadSession: boolean;
}): boolean {
  if (!params.shouldRequireMention) {
    return false;
  }
  return !params.isBoundThreadSession;
}

export function shouldIgnoreBoundThreadWebhookMessage(params: {
  accountId?: string;
  threadId?: string;
  webhookId?: string | null;
  threadBinding?: SessionBindingRecord;
}): boolean {
  const webhookId = params.webhookId?.trim() || "";
  if (!webhookId) {
    return false;
  }
  const boundWebhookId =
    typeof params.threadBinding?.metadata?.webhookId === "string"
      ? params.threadBinding.metadata.webhookId.trim()
      : "";
  if (!boundWebhookId) {
    const threadId = params.threadId?.trim() || "";
    if (!threadId) {
      return false;
    }
    return isRecentlyUnboundThreadWebhookMessage({
      accountId: params.accountId,
      threadId,
      webhookId,
    });
  }
  return webhookId === boundWebhookId;
}

export async function preflightDiscordMessage(
  params: DiscordMessagePreflightParams,
): Promise<DiscordMessagePreflightContext | null> {
  if (isPreflightAborted(params.abortSignal)) {
    return null;
  }
  const message = params.data.message;
  const author = params.data.author;
  if (!author) {
    return null;
  }

  const allowBotsSetting = params.discordConfig?.allowBots;
  const allowBotsMode =
    allowBotsSetting === "mentions" ? "mentions" : allowBotsSetting === true ? "all" : "off";
  if (params.botUserId && author.id === params.botUserId) {
    // Always ignore own messages to prevent self-reply loops
    return null;
  }

  const pluralkitConfig = params.discordConfig?.pluralkit;
  const webhookId = resolveDiscordWebhookId(message);
  const shouldCheckPluralKit = Boolean(pluralkitConfig?.enabled) && !webhookId;
  let pluralkitInfo: Awaited<ReturnType<typeof fetchPluralKitMessageInfo>> = null;
  if (shouldCheckPluralKit) {
    try {
      pluralkitInfo = await fetchPluralKitMessageInfo({
        messageId: message.id,
        config: pluralkitConfig,
      });
      if (isPreflightAborted(params.abortSignal)) {
        return null;
      }
    } catch (err) {
      logVerbose(`discord: pluralkit lookup failed for ${message.id}: ${String(err)}`);
    }
  }
  const sender = resolveDiscordSenderIdentity({
    author,
    member: params.data.member,
    pluralkitInfo,
  });

  const isGuildMessage = Boolean(params.data.guild_id);

  if (author.bot) {
    // Sibling bots (other agents in the same deployment) always bypass the bot filter
    const siblingBypass = isSiblingBot(author.id);

    // Rate-limit agent-to-agent messages to prevent infinite ping-pong loops
    if (siblingBypass && params.botUserId) {
      const blocked = checkA2ARateLimit(author.id, params.botUserId);
      if (blocked) {
        logVerbose(
          `discord: drop sibling bot message (A2A rate limit exceeded: ${author.id} <-> ${params.botUserId})`,
        );
        return null;
      }
    }

    // Track A2A responses: when a sibling bot posts, mark the oldest pending mention as responded.
    // Pass the message timestamp so only mentions sent BEFORE this response are matched (FIFO).
    if (siblingBypass) {
      const responderAgentId = getAgentIdForBot(author.id);
      if (responderAgentId) {
        const messageTs = resolveTimestampMs(message.timestamp);
        markMentionResponded(message.channelId, responderAgentId, {
          beforeTimestamp: messageTs,
        }).catch((err) => {
          logVerbose(`discord: a2a-retry mark responded failed: ${String(err)}`);
        });
      }
    }

    if (allowBotsMode === "off" && !sender.isPluralKit && !siblingBypass) {
      // When historyIncludeBots is enabled, record bot messages to guild history
      // before dropping them — gives multi-agent setups visibility into sibling output.
      const historyIncludeBots = params.discordConfig?.historyIncludeBots ?? false;
      if (historyIncludeBots && isGuildMessage && params.historyLimit > 0) {
        const botText = resolveDiscordMessageText(message, { includeForwarded: true });
        if (botText) {
          recordPendingHistoryEntryIfEnabled({
            historyMap: params.guildHistories,
            historyKey: message.channelId,
            limit: params.historyLimit,
            entry: {
              sender: sender.label,
              body: botText,
              timestamp: resolveTimestampMs(message.timestamp),
              messageId: message.id,
            },
          });
        }
      }
      logVerbose("discord: drop bot message (allowBots=false)");
      return null;
    }
  }

  const messageChannelId = resolveDiscordMessageChannelId({ message });
  const channelInfo = await resolveDiscordChannelInfo(params.client, messageChannelId);
  if (isPreflightAborted(params.abortSignal)) {
    return null;
  }
  const isDirectMessage = channelInfo?.type === ChannelType.DM;
  const isGroupDm = channelInfo?.type === ChannelType.GroupDM;
  logDebug(
    `[discord-preflight] channelId=${message.channelId} guild_id=${params.data.guild_id} channelType=${channelInfo?.type} isGuild=${isGuildMessage} isDM=${isDirectMessage} isGroupDm=${isGroupDm}`,
  );

  if (isGroupDm && !params.groupDmEnabled) {
    logVerbose("discord: drop group dm (group dms disabled)");
    return null;
  }
  if (isDirectMessage && !params.dmEnabled) {
    logVerbose("discord: drop dm (dms disabled)");
    return null;
  }

  const dmPolicy = params.discordConfig?.dmPolicy ?? params.discordConfig?.dm?.policy ?? "pairing";
  const useAccessGroups = params.cfg.commands?.useAccessGroups !== false;
  const resolvedAccountId = params.accountId ?? DEFAULT_ACCOUNT_ID;
  const allowNameMatching = isDangerousNameMatchingEnabled(params.discordConfig);
  let commandAuthorized = true;
  if (isDirectMessage) {
    if (dmPolicy === "disabled") {
      logVerbose("discord: drop dm (dmPolicy: disabled)");
      return null;
    }
    const dmAccess = await resolveDiscordDmCommandAccess({
      accountId: resolvedAccountId,
      dmPolicy,
      configuredAllowFrom: params.allowFrom ?? [],
      sender: {
        id: sender.id,
        name: sender.name,
        tag: sender.tag,
      },
      allowNameMatching,
      useAccessGroups,
    });
    if (isPreflightAborted(params.abortSignal)) {
      return null;
    }
    commandAuthorized = dmAccess.commandAuthorized;
    if (dmAccess.decision !== "allow") {
      const allowMatchMeta = formatAllowlistMatchMeta(
        dmAccess.allowMatch.allowed ? dmAccess.allowMatch : undefined,
      );
      await handleDiscordDmCommandDecision({
        dmAccess,
        accountId: resolvedAccountId,
        sender: {
          id: author.id,
          tag: formatDiscordUserTag(author),
          name: author.username ?? undefined,
        },
        onPairingCreated: async (code) => {
          logVerbose(
            `discord pairing request sender=${author.id} tag=${formatDiscordUserTag(author)} (${allowMatchMeta})`,
          );
          try {
            await sendMessageDiscord(
              `user:${author.id}`,
              buildPairingReply({
                channel: "discord",
                idLine: `Your Discord user id: ${author.id}`,
                code,
              }),
              {
                token: params.token,
                rest: params.client.rest,
                accountId: params.accountId,
              },
            );
          } catch (err) {
            logVerbose(`discord pairing reply failed for ${author.id}: ${String(err)}`);
          }
        },
        onUnauthorized: async () => {
          logVerbose(
            `Blocked unauthorized discord sender ${sender.id} (dmPolicy=${dmPolicy}, ${allowMatchMeta})`,
          );
        },
      });
      return null;
    }
  }

  const botId = params.botUserId;
  const baseText = resolveDiscordMessageText(message, {
    includeForwarded: false,
  });
  const messageText = resolveDiscordMessageText(message, {
    includeForwarded: true,
  });

  // Intercept text-only slash commands (e.g. user typing "/reset" instead of using Discord's slash command picker)
  // These should not be forwarded to the agent; proper slash command interactions are handled elsewhere
  if (!isDirectMessage && baseText && hasControlCommand(baseText, params.cfg)) {
    logVerbose(`discord: drop text-based slash command ${message.id} (intercepted at gateway)`);
    return null;
  }

  recordChannelActivity({
    channel: "discord",
    accountId: params.accountId,
    direction: "inbound",
  });

  // Resolve thread parent early for binding inheritance
  const channelName =
    channelInfo?.name ??
    ((isGuildMessage || isGroupDm) && message.channel && "name" in message.channel
      ? message.channel.name
      : undefined);
  const earlyThreadChannel = resolveDiscordThreadChannel({
    isGuildMessage,
    message,
    channelInfo,
  });
  let earlyThreadParentId: string | undefined;
  let earlyThreadParentName: string | undefined;
  let earlyThreadParentType: ChannelType | undefined;
  if (earlyThreadChannel) {
    const parentInfo = await resolveDiscordThreadParentInfo({
      client: params.client,
      threadChannel: earlyThreadChannel,
      channelInfo,
    });
    if (isPreflightAborted(params.abortSignal)) {
      return null;
    }
    earlyThreadParentId = parentInfo.id;
    earlyThreadParentName = parentInfo.name;
    earlyThreadParentType = parentInfo.type;
  }

  // Fresh config for bindings lookup; other routing inputs are payload-derived.
  const memberRoleIds = Array.isArray(params.data.member?.roles)
    ? params.data.member.roles.map((roleId: string) => String(roleId))
    : [];
  const freshCfg = loadConfig();
  const route = resolveDiscordConversationRoute({
    cfg: freshCfg,
    accountId: params.accountId,
    guildId: params.data.guild_id ?? undefined,
    memberRoleIds,
    peer: buildDiscordRoutePeer({
      isDirectMessage,
      isGroupDm,
      directUserId: author.id,
      conversationId: messageChannelId,
    }),
    parentConversationId: earlyThreadParentId,
  });
  let threadBinding: SessionBindingRecord | undefined;
  threadBinding =
    getSessionBindingService().resolveByConversation({
      channel: "discord",
      accountId: params.accountId,
      conversationId: messageChannelId,
      parentConversationId: earlyThreadParentId,
    }) ?? undefined;
  const configuredRoute =
    threadBinding == null
      ? resolveConfiguredAcpRoute({
          cfg: freshCfg,
          route,
          channel: "discord",
          accountId: params.accountId,
          conversationId: messageChannelId,
          parentConversationId: earlyThreadParentId,
        })
      : null;
  const configuredBinding = configuredRoute?.configuredBinding ?? null;
  if (!threadBinding && configuredBinding) {
    threadBinding = configuredBinding.record;
  }
  if (
    shouldIgnoreBoundThreadWebhookMessage({
      accountId: params.accountId,
      threadId: message.channelId,
      webhookId,
      threadBinding,
    })
  ) {
    logVerbose(`discord: drop bound-thread webhook echo message ${message.id}`);
    return null;
  }
  const boundSessionKey = threadBinding?.targetSessionKey?.trim();
  const effectiveRoute = resolveDiscordEffectiveRoute({
    route,
    boundSessionKey,
    configuredRoute,
    matchedBy: "binding.channel",
  });
  const boundAgentId = boundSessionKey ? effectiveRoute.agentId : undefined;
  const isBoundThreadSession = Boolean(boundSessionKey && earlyThreadChannel);
  if (
    isBoundThreadBotSystemMessage({
      isBoundThreadSession,
      isBotAuthor: Boolean(author.bot),
      text: messageText,
    })
  ) {
    logVerbose(`discord: drop bound-thread bot system message ${message.id}`);
    return null;
  }
  const mentionRegexes = buildMentionRegexes(params.cfg, effectiveRoute.agentId);
  const explicitlyMentioned = Boolean(
    botId && message.mentionedUsers?.some((user: User) => user.id === botId),
  );
  const hasAnyMention = Boolean(
    !isDirectMessage &&
    ((message.mentionedUsers?.length ?? 0) > 0 ||
      (message.mentionedRoles?.length ?? 0) > 0 ||
      (message.mentionedEveryone && (!author.bot || sender.isPluralKit))),
  );
  const hasUserOrRoleMention = Boolean(
    !isDirectMessage &&
    ((message.mentionedUsers?.length ?? 0) > 0 || (message.mentionedRoles?.length ?? 0) > 0),
  );

  if (
    isGuildMessage &&
    (message.type === MessageType.ChatInputCommand ||
      message.type === MessageType.ContextMenuCommand)
  ) {
    logVerbose("discord: drop channel command message");
    return null;
  }

  const guildInfo = isGuildMessage
    ? resolveDiscordGuildEntry({
        guild: params.data.guild ?? undefined,
        guildEntries: params.guildEntries,
      })
    : null;
  logDebug(
    `[discord-preflight] guild_id=${params.data.guild_id} guild_obj=${!!params.data.guild} guild_obj_id=${params.data.guild?.id} guildInfo=${!!guildInfo} guildEntries=${params.guildEntries ? Object.keys(params.guildEntries).join(",") : "none"}`,
  );
  if (
    isGuildMessage &&
    params.guildEntries &&
    Object.keys(params.guildEntries).length > 0 &&
    !guildInfo
  ) {
    logDebug(
      `[discord-preflight] guild blocked: guild_id=${params.data.guild_id} guildEntries keys=${Object.keys(params.guildEntries).join(",")}`,
    );
    logVerbose(
      `Blocked discord guild ${params.data.guild_id ?? "unknown"} (not in discord.guilds)`,
    );
    return null;
  }

  // Reuse early thread resolution from above (for binding inheritance)
  const threadChannel = earlyThreadChannel;
  const threadParentId = earlyThreadParentId;
  const threadParentName = earlyThreadParentName;
  const threadParentType = earlyThreadParentType;
  const threadName = threadChannel?.name;
  const configChannelName = threadParentName ?? channelName;
  const configChannelSlug = configChannelName ? normalizeDiscordSlug(configChannelName) : "";
  const displayChannelName = threadName ?? channelName;
  const displayChannelSlug = displayChannelName ? normalizeDiscordSlug(displayChannelName) : "";
  const guildSlug =
    guildInfo?.slug ||
    (params.data.guild?.name ? normalizeDiscordSlug(params.data.guild.name) : "");

  const threadChannelSlug = channelName ? normalizeDiscordSlug(channelName) : "";
  const threadParentSlug = threadParentName ? normalizeDiscordSlug(threadParentName) : "";

  const baseSessionKey = route.sessionKey;
  const channelConfig = isGuildMessage
    ? resolveDiscordChannelConfigWithFallback({
        guildInfo,
        channelId: message.channelId,
        channelName,
        channelSlug: threadChannelSlug,
        parentId: threadParentId ?? undefined,
        parentName: threadParentName ?? undefined,
        parentSlug: threadParentSlug,
        scope: threadChannel ? "thread" : "channel",
      })
    : null;
  const channelMatchMeta = formatAllowlistMatchMeta(channelConfig);
  if (shouldLogVerbose()) {
    const channelConfigSummary = channelConfig
      ? `allowed=${channelConfig.allowed} enabled=${channelConfig.enabled ?? "unset"} requireMention=${channelConfig.requireMention ?? "unset"} ignoreOtherMentions=${channelConfig.ignoreOtherMentions ?? "unset"} matchKey=${channelConfig.matchKey ?? "none"} matchSource=${channelConfig.matchSource ?? "none"} users=${channelConfig.users?.length ?? 0} roles=${channelConfig.roles?.length ?? 0} skills=${channelConfig.skills?.length ?? 0}`
      : "none";
    logDebug(
      `[discord-preflight] channelConfig=${channelConfigSummary} channelMatchMeta=${channelMatchMeta} channelId=${message.channelId}`,
    );
  }
  if (isGuildMessage && channelConfig?.enabled === false) {
    logDebug(`[discord-preflight] drop: channel disabled`);
    logVerbose(
      `Blocked discord channel ${message.channelId} (channel disabled, ${channelMatchMeta})`,
    );
    return null;
  }

  const groupDmAllowed =
    isGroupDm &&
    resolveGroupDmAllow({
      channels: params.groupDmChannels,
      channelId: message.channelId,
      channelName: displayChannelName,
      channelSlug: displayChannelSlug,
    });
  if (isGroupDm && !groupDmAllowed) {
    return null;
  }

  const channelAllowlistConfigured =
    Boolean(guildInfo?.channels) && Object.keys(guildInfo?.channels ?? {}).length > 0;
  const channelAllowed = channelConfig?.allowed !== false;
  if (
    isGuildMessage &&
    !isDiscordGroupAllowedByPolicy({
      groupPolicy: params.groupPolicy,
      guildAllowlisted: Boolean(guildInfo),
      channelAllowlistConfigured,
      channelAllowed,
    })
  ) {
    if (params.groupPolicy === "disabled") {
      logDebug(`[discord-preflight] drop: groupPolicy disabled`);
      logVerbose(`discord: drop guild message (groupPolicy: disabled, ${channelMatchMeta})`);
    } else if (!channelAllowlistConfigured) {
      logDebug(`[discord-preflight] drop: groupPolicy allowlist, no channel allowlist configured`);
      logVerbose(
        `discord: drop guild message (groupPolicy: allowlist, no channel allowlist, ${channelMatchMeta})`,
      );
    } else {
      logDebug(
        `[discord] Ignored message from channel ${message.channelId} (not in guild allowlist). Add to guilds.<guildId>.channels to enable.`,
      );
      logVerbose(
        `Blocked discord channel ${message.channelId} not in guild channel allowlist (groupPolicy: allowlist, ${channelMatchMeta})`,
      );
    }
    return null;
  }

  if (isGuildMessage && channelConfig?.allowed === false) {
    logDebug(`[discord-preflight] drop: channelConfig.allowed===false`);
    logVerbose(
      `Blocked discord channel ${message.channelId} not in guild channel allowlist (${channelMatchMeta})`,
    );
    return null;
  }
  if (isGuildMessage) {
    logDebug(`[discord-preflight] pass: channel allowed`);
    logVerbose(`discord: allow channel ${message.channelId} (${channelMatchMeta})`);
  }

  const textForHistory = resolveDiscordMessageText(message, {
    includeForwarded: true,
  });
  const historyEntry =
    isGuildMessage && params.historyLimit > 0 && textForHistory
      ? ({
          sender: sender.label,
          body: textForHistory,
          timestamp: resolveTimestampMs(message.timestamp),
          messageId: message.id,
        } satisfies HistoryEntry)
      : undefined;

  const threadOwnerId = threadChannel ? (threadChannel.ownerId ?? channelInfo?.ownerId) : undefined;
  const _shouldRequireMentionByConfig = resolveDiscordShouldRequireMention({
    isGuildMessage,
    isThread: Boolean(threadChannel),
    botId,
    threadOwnerId,
    channelConfig,
    guildInfo,
  });
  const shouldRequireMention = resolvePreflightMentionRequirement({
    shouldRequireMention: resolveDiscordShouldRequireMention({
      isGuildMessage,
      isThread: Boolean(threadChannel),
      botId,
      threadOwnerId,
      channelConfig,
      guildInfo,
    }),
    isBoundThreadSession: Boolean(boundSessionKey),
  });

  // Preflight audio transcription for mention detection in guilds.
  // This allows voice notes to be checked for mentions before being dropped.
  const { hasTypedText, transcript: preflightTranscript } =
    await resolveDiscordPreflightAudioMentionContext({
      message,
      isDirectMessage,
      shouldRequireMention,
      mentionRegexes,
      cfg: params.cfg,
      abortSignal: params.abortSignal,
    });
  if (isPreflightAborted(params.abortSignal)) {
    return null;
  }

  const mentionText = hasTypedText ? baseText : "";
  const wasMentioned =
    !isDirectMessage &&
    matchesMentionWithExplicit({
      text: mentionText,
      mentionRegexes,
      explicit: {
        hasAnyMention,
        isExplicitlyMentioned: explicitlyMentioned,
        canResolveExplicit: Boolean(botId),
      },
      transcript: preflightTranscript,
    });
  const implicitMention = Boolean(
    !isDirectMessage &&
    botId &&
    message.referencedMessage?.author?.id &&
    message.referencedMessage.author.id === botId,
  );
  if (shouldLogVerbose()) {
    logVerbose(
      `discord: inbound id=${message.id} guild=${params.data.guild_id ?? "dm"} channel=${message.channelId} mention=${wasMentioned ? "yes" : "no"} type=${isDirectMessage ? "dm" : isGroupDm ? "group-dm" : "guild"} content=${messageText ? "yes" : "no"}`,
    );
  }

  const allowTextCommands = shouldHandleTextCommands({
    cfg: params.cfg,
    surface: "discord",
  });
  const hasControlCommandInMessage = hasControlCommand(baseText, params.cfg);
  const channelUsers = channelConfig?.users ?? guildInfo?.users;
  const channelRoles = channelConfig?.roles ?? guildInfo?.roles;
  const hasAccessRestrictions =
    (Array.isArray(channelUsers) && channelUsers.length > 0) ||
    (Array.isArray(channelRoles) && channelRoles.length > 0);
  const memberAllowed = resolveDiscordMemberAllowed({
    userAllowList: channelUsers,
    roleAllowList: channelRoles,
    memberRoleIds,
    userId: sender.id,
    userName: sender.name,
    userTag: sender.tag,
    allowNameMatching,
  });

  if (!isDirectMessage) {
    const { ownerAllowList, ownerAllowed: ownerOk } = resolveDiscordOwnerAccess({
      allowFrom: params.allowFrom,
      sender: {
        id: sender.id,
        name: sender.name,
        tag: sender.tag,
      },
      allowNameMatching,
    });
    const commandGate = resolveControlCommandGate({
      useAccessGroups,
      authorizers: [
        { configured: ownerAllowList != null, allowed: ownerOk },
        { configured: hasAccessRestrictions, allowed: memberAllowed },
      ],
      modeWhenAccessGroupsOff: "configured",
      allowTextCommands,
      hasControlCommand: hasControlCommandInMessage,
    });
    commandAuthorized = commandGate.commandAuthorized;

    if (commandGate.shouldBlock) {
      logInboundDrop({
        log: logVerbose,
        channel: "discord",
        reason: "control command (unauthorized)",
        target: sender.id,
      });
      return null;
    }
  }

  const canDetectMention = Boolean(botId) || mentionRegexes.length > 0;
  const mentionGate = resolveMentionGatingWithBypass({
    isGroup: isGuildMessage,
    requireMention: Boolean(shouldRequireMention),
    canDetectMention,
    wasMentioned,
    implicitMention,
    hasAnyMention,
    allowTextCommands,
    hasControlCommand: hasControlCommandInMessage,
    commandAuthorized,
  });
  const effectiveWasMentioned = mentionGate.effectiveWasMentioned;
  logDebug(
    `[discord-preflight] shouldRequireMention=${shouldRequireMention} mentionGate.shouldSkip=${mentionGate.shouldSkip} wasMentioned=${wasMentioned}`,
  );
  // ── Handler/Observer: thread participant bypass ──
  // If I'm a registered participant in this thread, I'm a HANDLER regardless of mention.
  // If I'm explicitly mentioned in a thread, register as participant and become HANDLER.
  if (
    threadChannel &&
    params.botUserId &&
    isThreadParticipant(message.channelId, params.botUserId)
  ) {
    touchThreadActivity(message.channelId);
    // Skip mention gate — participant in this thread, no mention needed
  } else if (threadChannel && params.botUserId && explicitlyMentioned) {
    registerThreadParticipant(message.channelId, params.botUserId);
    touchThreadActivity(message.channelId);
    // Skip mention gate — just mentioned in thread, now registered as participant
  } else if (threadChannel && params.botUserId && !boundSessionKey) {
    // Not a participant and not mentioned in this thread — drop silently.
    // Without this guard every agent bot in the guild would respond to
    // thread messages in channels where shouldRequireMention is false.
    // Bound thread sessions are exempt: the binding itself authorizes processing.
    logVerbose(
      `discord: drop thread message (not a participant) channel=${message.channelId} bot=${params.botUserId}`,
    );
    if (historyEntry) {
      recordPendingHistoryEntryIfEnabled({
        historyMap: params.guildHistories,
        historyKey: message.channelId,
        limit: params.historyLimit,
        entry: historyEntry,
      });
    }
    return null;
  } else if (isGuildMessage && shouldRequireMention) {
    if (botId && mentionGate.shouldSkip) {
      logDebug(`[discord-preflight] drop: no-mention`);
      logVerbose(`discord: drop guild message (mention required, botId=${botId})`);
      recordPendingHistoryEntryIfEnabled({
        historyMap: params.guildHistories,
        historyKey: message.channelId,
        limit: params.historyLimit,
        entry: historyEntry ?? null,
      });
      return null;
    }
  }

  // ── Observer: sibling bot messages in threads where I'm not a participant ──
  if (
    threadChannel &&
    author.bot &&
    isSiblingBot(author.id) &&
    params.botUserId &&
    !isThreadParticipant(message.channelId, params.botUserId) &&
    !explicitlyMentioned
  ) {
    logVerbose(`discord: observer mode for sibling bot message in thread ${message.channelId}`);
    if (historyEntry) {
      recordPendingHistoryEntryIfEnabled({
        historyMap: params.guildHistories,
        historyKey: message.channelId,
        limit: params.historyLimit,
        entry: historyEntry,
      });
    }
    return null;
  }

  // ── Observer: another bot was explicitly mentioned in guild, not us ──
  if (
    isGuildMessage &&
    !explicitlyMentioned &&
    message.mentionedUsers?.some((u: { id: string }) => isSiblingBot(u.id))
  ) {
    logVerbose(`discord: observer mode — another bot was explicitly mentioned`);
    if (historyEntry) {
      recordPendingHistoryEntryIfEnabled({
        historyMap: params.guildHistories,
        historyKey: message.channelId,
        limit: params.historyLimit,
        entry: historyEntry,
      });
    }
    return null;
  }

  if (author.bot && !sender.isPluralKit && allowBotsMode === "mentions") {
    const botMentioned = isDirectMessage || wasMentioned || implicitMention;
    if (!botMentioned) {
      logDebug(`[discord-preflight] drop: bot message missing mention (allowBots=mentions)`);
      logVerbose("discord: drop bot message (allowBots=mentions, missing mention)");
      return null;
    }
  }

  const ignoreOtherMentions =
    channelConfig?.ignoreOtherMentions ?? guildInfo?.ignoreOtherMentions ?? false;
  if (
    isGuildMessage &&
    ignoreOtherMentions &&
    hasUserOrRoleMention &&
    !wasMentioned &&
    !implicitMention
  ) {
    logDebug(`[discord-preflight] drop: other-mention`);
    logVerbose(
      `discord: drop guild message (another user/role mentioned, ignoreOtherMentions=true, botId=${botId})`,
    );
    recordPendingHistoryEntryIfEnabled({
      historyMap: params.guildHistories,
      historyKey: messageChannelId,
      limit: params.historyLimit,
      entry: historyEntry ?? null,
    });
    return null;
  }

  if (isGuildMessage && hasAccessRestrictions && !memberAllowed) {
    logDebug(`[discord-preflight] drop: member not allowed`);
    logVerbose(`Blocked discord guild sender ${sender.id} (not in users/roles allowlist)`);
    return null;
  }

  const systemLocation = resolveDiscordSystemLocation({
    isDirectMessage,
    isGroupDm,
    guild: params.data.guild ?? undefined,
    channelName: channelName ?? message.channelId,
  });
  const systemText = resolveDiscordSystemEvent(message, systemLocation);
  if (systemText) {
    logDebug(`[discord-preflight] drop: system event`);
    enqueueSystemEvent(systemText, {
      sessionKey: route.sessionKey,
      contextKey: `discord:system:${message.channelId}:${message.id}`,
    });
    return null;
  }

  if (!messageText) {
    logDebug(`[discord-preflight] drop: empty content`);
    logVerbose(`discord: drop message ${message.id} (empty content)`);
    return null;
  }
  if (configuredBinding) {
    const ensured = await ensureConfiguredAcpRouteReady({
      cfg: freshCfg,
      configuredBinding,
    });
    if (!ensured.ok) {
      logVerbose(
        `discord: configured ACP binding unavailable for channel ${configuredBinding.spec.conversationId}: ${ensured.error}`,
      );
      return null;
    }
  }

  logDebug(`[discord-preflight] success: route=${route.agentId} sessionKey=${route.sessionKey}`);
  return {
    cfg: params.cfg,
    discordConfig: params.discordConfig,
    accountId: params.accountId,
    token: params.token,
    runtime: params.runtime,
    botUserId: params.botUserId,
    abortSignal: params.abortSignal,
    guildHistories: params.guildHistories,
    historyLimit: params.historyLimit,
    mediaMaxBytes: params.mediaMaxBytes,
    textLimit: params.textLimit,
    replyToMode: params.replyToMode,
    ackReactionScope: params.ackReactionScope,
    groupPolicy: params.groupPolicy,
    data: params.data,
    client: params.client,
    messageChannelId: message.channel_id,
    message,
    author,
    sender,
    channelInfo,
    channelName,
    isGuildMessage,
    isDirectMessage,
    isGroupDm,
    commandAuthorized,
    baseText,
    messageText,
    wasMentioned,
    route: effectiveRoute,
    boundSessionKey,
    boundAgentId,
    guildInfo,
    guildSlug,
    threadChannel,
    threadParentId,
    threadParentName,
    threadParentType,
    threadName,
    configChannelName,
    configChannelSlug,
    displayChannelName,
    displayChannelSlug,
    baseSessionKey,
    channelConfig,
    channelAllowlistConfigured,
    channelAllowed,
    shouldRequireMention,
    hasAnyMention,
    allowTextCommands,
    shouldBypassMention: mentionGate.shouldBypassMention,
    effectiveWasMentioned,
    canDetectMention,
    historyEntry,
    threadBindings: params.threadBindings,
    discordRestFetch: params.discordRestFetch,
  };
}
