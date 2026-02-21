import { ChannelType, MessageType, type User } from "@buape/carbon";
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
import { logVerbose, shouldLogVerbose } from "../../globals.js";
import { recordChannelActivity } from "../../infra/channel-activity.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { logDebug } from "../../logger.js";
import { getChildLogger } from "../../logging.js";
import { buildPairingReply } from "../../pairing/pairing-messages.js";
import {
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "../../pairing/pairing-store.js";
import { resolveAgentRoute } from "../../routing/resolve-route.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { fetchPluralKitMessageInfo } from "../pluralkit.js";
import { sendMessageDiscord } from "../send.js";
import {
  allowListMatches,
  isDiscordGroupAllowedByPolicy,
  normalizeDiscordAllowList,
  normalizeDiscordSlug,
  resolveDiscordAllowListMatch,
  resolveDiscordChannelConfigWithFallback,
  resolveDiscordGuildEntry,
  resolveDiscordMemberAccessState,
  resolveDiscordShouldRequireMention,
  resolveGroupDmAllow,
} from "./allow-list.js";
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
import { resolveDiscordSenderIdentity, resolveDiscordWebhookId } from "./sender-identity.js";
import { resolveDiscordSystemEvent } from "./system-events.js";
import {
  isRecentlyUnboundThreadWebhookMessage,
  type ThreadBindingRecord,
} from "./thread-bindings.js";
import { resolveDiscordThreadChannel, resolveDiscordThreadParentInfo } from "./threading.js";

export type {
  DiscordMessagePreflightContext,
  DiscordMessagePreflightParams,
} from "./message-handler.preflight.types.js";

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
  threadBinding?: ThreadBindingRecord;
}): boolean {
  const webhookId = params.webhookId?.trim() || "";
  if (!webhookId) {
    return false;
  }
  const boundWebhookId = params.threadBinding?.webhookId?.trim() || "";
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
  const logger = getChildLogger({ module: "discord-auto-reply" });
  const message = params.data.message;
  const author = params.data.author;
  if (!author) {
    return null;
  }
  const messageChannelId = resolveDiscordMessageChannelId({
    message,
    eventChannelId: params.data.channel_id,
  });
  if (!messageChannelId) {
    logVerbose(`discord: drop message ${message.id} (missing channel id)`);
    return null;
  }

  const allowBots = params.discordConfig?.allowBots ?? false;
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
    } catch (err) {
      logVerbose(`discord: pluralkit lookup failed for ${message.id}: ${String(err)}`);
    }
  }
  const sender = resolveDiscordSenderIdentity({
    author,
    member: params.data.member,
    pluralkitInfo,
  });

  if (author.bot) {
    if (!allowBots && !sender.isPluralKit) {
      logVerbose("discord: drop bot message (allowBots=false)");
      return null;
    }
  }

  const isGuildMessage = Boolean(params.data.guild_id);
  const channelInfo = await resolveDiscordChannelInfo(params.client, messageChannelId);
  const isDirectMessage = channelInfo?.type === ChannelType.DM;
  const isGroupDm = channelInfo?.type === ChannelType.GroupDM;
  logDebug(
    `[discord-preflight] channelId=${messageChannelId} guild_id=${params.data.guild_id} channelType=${channelInfo?.type} isGuild=${isGuildMessage} isDM=${isDirectMessage} isGroupDm=${isGroupDm}`,
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
  let commandAuthorized = true;
  if (isDirectMessage) {
    if (dmPolicy === "disabled") {
      logVerbose("discord: drop dm (dmPolicy: disabled)");
      return null;
    }
    if (dmPolicy !== "open") {
      const storeAllowFrom =
        dmPolicy === "allowlist" ? [] : await readChannelAllowFromStore("discord").catch(() => []);
      const effectiveAllowFrom = [...(params.allowFrom ?? []), ...storeAllowFrom];
      const allowList = normalizeDiscordAllowList(effectiveAllowFrom, ["discord:", "user:", "pk:"]);
      const allowMatch = allowList
        ? resolveDiscordAllowListMatch({
            allowList,
            candidate: {
              id: sender.id,
              name: sender.name,
              tag: sender.tag,
            },
          })
        : { allowed: false };
      const allowMatchMeta = formatAllowlistMatchMeta(allowMatch);
      const permitted = allowMatch.allowed;
      if (!permitted) {
        commandAuthorized = false;
        if (dmPolicy === "pairing") {
          const { code, created } = await upsertChannelPairingRequest({
            channel: "discord",
            id: author.id,
            meta: {
              tag: formatDiscordUserTag(author),
              name: author.username ?? undefined,
            },
          });
          if (created) {
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
          }
        } else {
          logVerbose(
            `Blocked unauthorized discord sender ${sender.id} (dmPolicy=${dmPolicy}, ${allowMatchMeta})`,
          );
        }
        return null;
      }
      commandAuthorized = true;
    }
  }

  const botId = params.botUserId;
  const baseText = resolveDiscordMessageText(message, {
    includeForwarded: false,
  });
  const messageText = resolveDiscordMessageText(message, {
    includeForwarded: true,
  });
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
    messageChannelId,
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
    earlyThreadParentId = parentInfo.id;
    earlyThreadParentName = parentInfo.name;
    earlyThreadParentType = parentInfo.type;
  }

  // Fresh config for bindings lookup; other routing inputs are payload-derived.
  const memberRoleIds = Array.isArray(params.data.rawMember?.roles)
    ? params.data.rawMember.roles.map((roleId: string) => String(roleId))
    : [];
  const route = resolveAgentRoute({
    cfg: loadConfig(),
    channel: "discord",
    accountId: params.accountId,
    guildId: params.data.guild_id ?? undefined,
    memberRoleIds,
    peer: {
      kind: isDirectMessage ? "direct" : isGroupDm ? "group" : "channel",
      id: isDirectMessage ? author.id : messageChannelId,
    },
    // Pass parent peer for thread binding inheritance
    parentPeer: earlyThreadParentId ? { kind: "channel", id: earlyThreadParentId } : undefined,
  });
  const threadBinding = earlyThreadChannel
    ? params.threadBindings.getByThreadId(messageChannelId)
    : undefined;
  if (
    shouldIgnoreBoundThreadWebhookMessage({
      accountId: params.accountId,
      threadId: messageChannelId,
      webhookId,
      threadBinding,
    })
  ) {
    logVerbose(`discord: drop bound-thread webhook echo message ${message.id}`);
    return null;
  }
  const boundSessionKey = threadBinding?.targetSessionKey?.trim();
  const boundAgentId = boundSessionKey ? resolveAgentIdFromSessionKey(boundSessionKey) : undefined;
  const effectiveRoute = boundSessionKey
    ? {
        ...route,
        sessionKey: boundSessionKey,
        agentId: boundAgentId ?? route.agentId,
      }
    : route;
  const mentionRegexes = buildMentionRegexes(params.cfg, effectiveRoute.agentId);
  const explicitlyMentioned = Boolean(
    botId && message.mentionedUsers?.some((user: User) => user.id === botId),
  );
  const hasAnyMention = Boolean(
    !isDirectMessage &&
    (message.mentionedEveryone ||
      (message.mentionedUsers?.length ?? 0) > 0 ||
      (message.mentionedRoles?.length ?? 0) > 0),
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

  const baseSessionKey = effectiveRoute.sessionKey;
  const channelConfig = isGuildMessage
    ? resolveDiscordChannelConfigWithFallback({
        guildInfo,
        channelId: messageChannelId,
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
      ? `allowed=${channelConfig.allowed} enabled=${channelConfig.enabled ?? "unset"} requireMention=${channelConfig.requireMention ?? "unset"} matchKey=${channelConfig.matchKey ?? "none"} matchSource=${channelConfig.matchSource ?? "none"} users=${channelConfig.users?.length ?? 0} roles=${channelConfig.roles?.length ?? 0} skills=${channelConfig.skills?.length ?? 0}`
      : "none";
    logDebug(
      `[discord-preflight] channelConfig=${channelConfigSummary} channelMatchMeta=${channelMatchMeta} channelId=${messageChannelId}`,
    );
  }
  if (isGuildMessage && channelConfig?.enabled === false) {
    logDebug(`[discord-preflight] drop: channel disabled`);
    logVerbose(
      `Blocked discord channel ${messageChannelId} (channel disabled, ${channelMatchMeta})`,
    );
    return null;
  }

  const groupDmAllowed =
    isGroupDm &&
    resolveGroupDmAllow({
      channels: params.groupDmChannels,
      channelId: messageChannelId,
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
      logVerbose(`discord: drop guild message (groupPolicy: disabled, ${channelMatchMeta})`);
    } else if (!channelAllowlistConfigured) {
      logVerbose(
        `discord: drop guild message (groupPolicy: allowlist, no channel allowlist, ${channelMatchMeta})`,
      );
    } else {
      logVerbose(
        `Blocked discord channel ${messageChannelId} not in guild channel allowlist (groupPolicy: allowlist, ${channelMatchMeta})`,
      );
    }
    return null;
  }

  if (isGuildMessage && channelConfig?.allowed === false) {
    logDebug(`[discord-preflight] drop: channelConfig.allowed===false`);
    logVerbose(
      `Blocked discord channel ${messageChannelId} not in guild channel allowlist (${channelMatchMeta})`,
    );
    return null;
  }
  if (isGuildMessage) {
    logDebug(`[discord-preflight] pass: channel allowed`);
    logVerbose(`discord: allow channel ${messageChannelId} (${channelMatchMeta})`);
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
  const shouldRequireMentionByConfig = resolveDiscordShouldRequireMention({
    isGuildMessage,
    isThread: Boolean(threadChannel),
    botId,
    threadOwnerId,
    channelConfig,
    guildInfo,
  });
  const isBoundThreadSession = Boolean(boundSessionKey && threadChannel);
  const shouldRequireMention = resolvePreflightMentionRequirement({
    shouldRequireMention: shouldRequireMentionByConfig,
    isBoundThreadSession,
  });

  // Preflight audio transcription for mention detection in guilds
  // This allows voice notes to be checked for mentions before being dropped
  let preflightTranscript: string | undefined;
  const hasAudioAttachment = message.attachments?.some((att: { contentType?: string }) =>
    att.contentType?.startsWith("audio/"),
  );
  const needsPreflightTranscription =
    !isDirectMessage &&
    shouldRequireMention &&
    hasAudioAttachment &&
    !baseText &&
    mentionRegexes.length > 0;

  if (needsPreflightTranscription) {
    try {
      const { transcribeFirstAudio } = await import("../../media-understanding/audio-preflight.js");
      const audioPaths =
        message.attachments
          ?.filter((att: { contentType?: string; url: string }) =>
            att.contentType?.startsWith("audio/"),
          )
          .map((att: { url: string }) => att.url) ?? [];
      if (audioPaths.length > 0) {
        const tempCtx = {
          MediaUrls: audioPaths,
          MediaTypes: message.attachments
            ?.filter((att: { contentType?: string; url: string }) =>
              att.contentType?.startsWith("audio/"),
            )
            .map((att: { contentType?: string }) => att.contentType)
            .filter(Boolean) as string[],
        };
        preflightTranscript = await transcribeFirstAudio({
          ctx: tempCtx,
          cfg: params.cfg,
          agentDir: undefined,
        });
      }
    } catch (err) {
      logVerbose(`discord: audio preflight transcription failed: ${String(err)}`);
    }
  }

  const wasMentioned =
    !isDirectMessage &&
    matchesMentionWithExplicit({
      text: baseText,
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
      `discord: inbound id=${message.id} guild=${params.data.guild_id ?? "dm"} channel=${messageChannelId} mention=${wasMentioned ? "yes" : "no"} type=${isDirectMessage ? "dm" : isGroupDm ? "group-dm" : "guild"} content=${messageText ? "yes" : "no"}`,
    );
  }

  const allowTextCommands = shouldHandleTextCommands({
    cfg: params.cfg,
    surface: "discord",
  });
  const hasControlCommandInMessage = hasControlCommand(baseText, params.cfg);
  const { hasAccessRestrictions, memberAllowed } = resolveDiscordMemberAccessState({
    channelConfig,
    guildInfo,
    memberRoleIds,
    sender,
  });

  if (!isDirectMessage) {
    const ownerAllowList = normalizeDiscordAllowList(params.allowFrom, [
      "discord:",
      "user:",
      "pk:",
    ]);
    const ownerOk = ownerAllowList
      ? allowListMatches(ownerAllowList, {
          id: sender.id,
          name: sender.name,
          tag: sender.tag,
        })
      : false;
    const useAccessGroups = params.cfg.commands?.useAccessGroups !== false;
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
    `[discord-preflight] shouldRequireMention=${shouldRequireMention} baseRequireMention=${shouldRequireMentionByConfig} boundThreadSession=${isBoundThreadSession} mentionGate.shouldSkip=${mentionGate.shouldSkip} wasMentioned=${wasMentioned}`,
  );
  if (isGuildMessage && shouldRequireMention) {
    if (botId && mentionGate.shouldSkip) {
      logDebug(`[discord-preflight] drop: no-mention`);
      logVerbose(`discord: drop guild message (mention required, botId=${botId})`);
      logger.info(
        {
          channelId: messageChannelId,
          reason: "no-mention",
        },
        "discord: skipping guild message",
      );
      recordPendingHistoryEntryIfEnabled({
        historyMap: params.guildHistories,
        historyKey: messageChannelId,
        limit: params.historyLimit,
        entry: historyEntry ?? null,
      });
      return null;
    }
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
    channelName: channelName ?? messageChannelId,
  });
  const systemText = resolveDiscordSystemEvent(message, systemLocation);
  if (systemText) {
    logDebug(`[discord-preflight] drop: system event`);
    enqueueSystemEvent(systemText, {
      sessionKey: effectiveRoute.sessionKey,
      contextKey: `discord:system:${messageChannelId}:${message.id}`,
    });
    return null;
  }

  if (!messageText) {
    logDebug(`[discord-preflight] drop: empty content`);
    logVerbose(`discord: drop message ${message.id} (empty content)`);
    return null;
  }

  logDebug(
    `[discord-preflight] success: route=${effectiveRoute.agentId} sessionKey=${effectiveRoute.sessionKey}`,
  );
  return {
    cfg: params.cfg,
    discordConfig: params.discordConfig,
    accountId: params.accountId,
    token: params.token,
    runtime: params.runtime,
    botUserId: params.botUserId,
    guildHistories: params.guildHistories,
    historyLimit: params.historyLimit,
    mediaMaxBytes: params.mediaMaxBytes,
    textLimit: params.textLimit,
    replyToMode: params.replyToMode,
    ackReactionScope: params.ackReactionScope,
    groupPolicy: params.groupPolicy,
    data: params.data,
    client: params.client,
    message,
    messageChannelId,
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
    threadBinding,
    boundSessionKey: boundSessionKey || undefined,
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
  };
}
