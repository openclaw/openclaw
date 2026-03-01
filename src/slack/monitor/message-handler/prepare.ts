import { resolveAckReaction } from "../../../agents/identity.js";
import { hasControlCommand } from "../../../auto-reply/command-detection.js";
import { shouldHandleTextCommands } from "../../../auto-reply/commands-registry.js";
import {
  formatInboundEnvelope,
  resolveEnvelopeFormatOptions,
} from "../../../auto-reply/envelope.js";
import {
  buildPendingHistoryContextFromMap,
  recordPendingHistoryEntryIfEnabled,
} from "../../../auto-reply/reply/history.js";
import { finalizeInboundContext } from "../../../auto-reply/reply/inbound-context.js";
import {
  buildMentionRegexes,
  matchesMentionWithExplicit,
} from "../../../auto-reply/reply/mentions.js";
import type { FinalizedMsgContext } from "../../../auto-reply/templating.js";
import {
  shouldAckReaction as shouldAckReactionGate,
  type AckReactionScope,
} from "../../../channels/ack-reactions.js";
import { resolveControlCommandGate } from "../../../channels/command-gating.js";
import { resolveConversationLabel } from "../../../channels/conversation-label.js";
import { logInboundDrop } from "../../../channels/logging.js";
import { resolveMentionGatingWithBypass } from "../../../channels/mention-gating.js";
import { recordInboundSession } from "../../../channels/session.js";
import { readSessionUpdatedAt, resolveStorePath } from "../../../config/sessions.js";
import { logVerbose, shouldLogVerbose } from "../../../globals.js";
import { enqueueSystemEvent } from "../../../infra/system-events.js";
import { resolveAgentRoute } from "../../../routing/resolve-route.js";
import { resolveThreadSessionKeys } from "../../../routing/session-key.js";
import { resolveSlackReplyToMode, type ResolvedSlackAccount } from "../../accounts.js";
import { reactSlackMessage } from "../../actions.js";
import { sendMessageSlack } from "../../send.js";
import { hasSlackThreadParticipation } from "../../sent-thread-cache.js";
import { resolveSlackThreadContext } from "../../threading.js";
import type { SlackMessageEvent } from "../../types.js";
import { resolveSlackAllowListMatch, resolveSlackUserAllowed } from "../allow-list.js";
import { resolveSlackEffectiveAllowFrom } from "../auth.js";
import { resolveSlackChannelConfig } from "../channel-config.js";
import { stripSlackMentionsForCommandDetection } from "../commands.js";
import { normalizeSlackChannelType, type SlackMonitorContext } from "../context.js";
import { authorizeSlackDirectMessage } from "../dm-auth.js";
import {
  resolveSlackAttachmentContent,
  MAX_SLACK_MEDIA_FILES,
  resolveSlackMedia,
  resolveSlackThreadHistory,
  resolveSlackThreadStarter,
} from "../media.js";
import { resolveSlackRoomContextHints } from "../room-context.js";
import type { PreparedSlackMessage } from "./types.js";

export async function prepareSlackMessage(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
  message: SlackMessageEvent;
  opts: { source: "message" | "app_mention"; wasMentioned?: boolean };
}): Promise<PreparedSlackMessage | null> {
  const { ctx, account, message, opts } = params;
  const cfg = ctx.cfg;

  let channelInfo: {
    name?: string;
    type?: SlackMessageEvent["channel_type"];
    topic?: string;
    purpose?: string;
  } = {};
  let channelType = message.channel_type;
  if (!channelType || channelType !== "im") {
    channelInfo = await ctx.resolveChannelName(message.channel);
    channelType = channelType ?? channelInfo.type;
  }
  const channelName = channelInfo?.name;
  const resolvedChannelType = normalizeSlackChannelType(channelType, message.channel);
  const isDirectMessage = resolvedChannelType === "im";
  const isGroupDm = resolvedChannelType === "mpim";
  const isRoom = resolvedChannelType === "channel" || resolvedChannelType === "group";
  const isRoomish = isRoom || isGroupDm;

  const channelConfig = isRoom
    ? resolveSlackChannelConfig({
        channelId: message.channel,
        channelName,
        channels: ctx.channelsConfig,
        defaultRequireMention: ctx.defaultRequireMention,
      })
    : null;

  const allowBots =
    channelConfig?.allowBots ??
    account.config?.allowBots ??
    cfg.channels?.slack?.allowBots ??
    false;

  const isBotMessage = Boolean(message.bot_id);
  if (isBotMessage) {
    if (message.user && ctx.botUserId && message.user === ctx.botUserId) {
      return null;
    }
    if (!allowBots) {
      logVerbose(`slack: drop bot message ${message.bot_id ?? "unknown"} (allowBots=false)`);
      return null;
    }
  }

  if (isDirectMessage && !message.user) {
    logVerbose("slack: drop dm message (missing user id)");
    return null;
  }

  const senderId = message.user ?? (isBotMessage ? message.bot_id : undefined);
  if (!senderId) {
    logVerbose("slack: drop message (missing sender id)");
    return null;
  }

  if (
    !ctx.isChannelAllowed({
      channelId: message.channel,
      channelName,
      channelType: resolvedChannelType,
    })
  ) {
    logVerbose("slack: drop message (channel not allowed)");
    return null;
  }

  const { allowFromLower } = await resolveSlackEffectiveAllowFrom(ctx, {
    includePairingStore: isDirectMessage,
  });

  if (isDirectMessage) {
    const directUserId = message.user;
    if (!directUserId) {
      logVerbose("slack: drop dm message (missing user id)");
      return null;
    }
    const allowed = await authorizeSlackDirectMessage({
      ctx,
      accountId: account.accountId,
      senderId: directUserId,
      allowFromLower,
      resolveSenderName: ctx.resolveUserName,
      sendPairingReply: async (text) => {
        await sendMessageSlack(message.channel, text, {
          token: ctx.botToken,
          client: ctx.app.client,
          accountId: account.accountId,
        });
      },
      onDisabled: () => {
        logVerbose("slack: drop dm (dms disabled)");
      },
      onUnauthorized: ({ allowMatchMeta }) => {
        logVerbose(
          `Blocked unauthorized slack sender ${message.user} (dmPolicy=${ctx.dmPolicy}, ${allowMatchMeta})`,
        );
      },
      log: logVerbose,
    });
    if (!allowed) {
      return null;
    }
  }

  const route = resolveAgentRoute({
    cfg,
    channel: "slack",
    accountId: account.accountId,
    teamId: ctx.teamId || undefined,
    peer: {
      kind: isDirectMessage ? "direct" : isRoom ? "channel" : "group",
      id: isDirectMessage ? (message.user ?? "unknown") : message.channel,
    },
  });

  const baseSessionKey = route.sessionKey;
  const chatType = isDirectMessage ? "direct" : isGroupDm ? "group" : "channel";
  const replyToMode = resolveSlackReplyToMode(account, chatType);
  const threadContext = resolveSlackThreadContext({ message, replyToMode });
  const threadTs = threadContext.incomingThreadTs;
  const isThreadReply = threadContext.isThreadReply;
  const threadKeys = resolveThreadSessionKeys({
    baseSessionKey,
    threadId: isThreadReply ? threadTs : undefined,
    parentSessionKey: isThreadReply && ctx.threadInheritParent ? baseSessionKey : undefined,
  });
  const sessionKey = threadKeys.sessionKey;
  const historyKey =
    isThreadReply && ctx.threadHistoryScope === "thread" ? sessionKey : message.channel;

  const mentionRegexes = buildMentionRegexes(cfg, route.agentId);
  const hasAnyMention = /<@[^>]+>/.test(message.text ?? "");
  const explicitlyMentioned = Boolean(
    ctx.botUserId && message.text?.includes(`<@${ctx.botUserId}>`),
  );
  const wasMentioned =
    opts.wasMentioned ??
    (!isDirectMessage &&
      matchesMentionWithExplicit({
        text: message.text ?? "",
        mentionRegexes,
        explicit: {
          hasAnyMention,
          isExplicitlyMentioned: explicitlyMentioned,
          canResolveExplicit: Boolean(ctx.botUserId),
        },
      }));
  const implicitMention = Boolean(
    !isDirectMessage &&
    ctx.botUserId &&
    message.thread_ts &&
    (message.parent_user_id === ctx.botUserId ||
      hasSlackThreadParticipation(account.accountId, message.channel, message.thread_ts)),
  );

  const sender = message.user ? await ctx.resolveUserName(message.user) : null;
  const senderName =
    sender?.name ?? message.username?.trim() ?? message.user ?? message.bot_id ?? "unknown";

  const channelUserAuthorized = isRoom
    ? resolveSlackUserAllowed({
        allowList: channelConfig?.users,
        userId: senderId,
        userName: senderName,
        allowNameMatching: ctx.allowNameMatching,
      })
    : true;
  if (isRoom && !channelUserAuthorized) {
    logVerbose(`Blocked unauthorized slack sender ${senderId} (not in channel users)`);
    return null;
  }

  const allowTextCommands = shouldHandleTextCommands({
    cfg,
    surface: "slack",
  });
  // Strip Slack mentions (<@U123>) before command detection so "@Labrador /new" is recognized
  const textForCommandDetection = stripSlackMentionsForCommandDetection(message.text ?? "");
  const hasControlCommandInMessage = hasControlCommand(textForCommandDetection, cfg);

  const ownerAuthorized = resolveSlackAllowListMatch({
    allowList: allowFromLower,
    id: senderId,
    name: senderName,
    allowNameMatching: ctx.allowNameMatching,
  }).allowed;
  const channelUsersAllowlistConfigured =
    isRoom && Array.isArray(channelConfig?.users) && channelConfig.users.length > 0;
  const channelCommandAuthorized =
    isRoom && channelUsersAllowlistConfigured
      ? resolveSlackUserAllowed({
          allowList: channelConfig?.users,
          userId: senderId,
          userName: senderName,
          allowNameMatching: ctx.allowNameMatching,
        })
      : false;
  const commandGate = resolveControlCommandGate({
    useAccessGroups: ctx.useAccessGroups,
    authorizers: [
      { configured: allowFromLower.length > 0, allowed: ownerAuthorized },
      {
        configured: channelUsersAllowlistConfigured,
        allowed: channelCommandAuthorized,
      },
    ],
    allowTextCommands,
    hasControlCommand: hasControlCommandInMessage,
  });
  const commandAuthorized = commandGate.commandAuthorized;

  if (isRoomish && commandGate.shouldBlock) {
    logInboundDrop({
      log: logVerbose,
      channel: "slack",
      reason: "control command (unauthorized)",
      target: senderId,
    });
    return null;
  }

  const shouldRequireMention = isRoom
    ? (channelConfig?.requireMention ?? ctx.defaultRequireMention)
    : false;

  // Allow "control commands" to bypass mention gating if sender is authorized.
  const canDetectMention = Boolean(ctx.botUserId) || mentionRegexes.length > 0;
  const mentionGate = resolveMentionGatingWithBypass({
    isGroup: isRoom,
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
  if (isRoom && shouldRequireMention && mentionGate.shouldSkip) {
    ctx.logger.info({ channel: message.channel, reason: "no-mention" }, "skipping channel message");
    const pendingText = (message.text ?? "").trim();
    const fallbackFile = message.files?.[0]?.name
      ? `[Slack file: ${message.files[0].name}]`
      : message.files?.length
        ? "[Slack file]"
        : "";
    const pendingBody = pendingText || fallbackFile;
    recordPendingHistoryEntryIfEnabled({
      historyMap: ctx.channelHistories,
      historyKey,
      limit: ctx.historyLimit,
      entry: pendingBody
        ? {
            sender: senderName,
            body: pendingBody,
            timestamp: message.ts ? Math.round(Number(message.ts) * 1000) : undefined,
            messageId: message.ts,
          }
        : null,
    });
    return null;
  }

  const media = await resolveSlackMedia({
    files: message.files,
    token: ctx.botToken,
    maxBytes: ctx.mediaMaxBytes,
  });

  // Resolve forwarded message content (text + media) from Slack attachments
  const attachmentContent = await resolveSlackAttachmentContent({
    attachments: message.attachments,
    token: ctx.botToken,
    maxBytes: ctx.mediaMaxBytes,
  });

  // Merge forwarded media into the message's media array
  const mergedMedia = [...(media ?? []), ...(attachmentContent?.media ?? [])];
  const effectiveDirectMedia = mergedMedia.length > 0 ? mergedMedia : null;

  const mediaPlaceholder = effectiveDirectMedia
    ? effectiveDirectMedia.map((m) => m.placeholder).join(" ")
    : undefined;

  // When files were attached but all downloads failed, create a fallback
  // placeholder so the message is still delivered to the agent instead of
  // being silently dropped (#25064).
  const fileOnlyFallback =
    !mediaPlaceholder && (message.files?.length ?? 0) > 0
      ? message
          .files!.slice(0, MAX_SLACK_MEDIA_FILES)
          .map((f) => f.name?.trim() || "file")
          .join(", ")
      : undefined;
  const fileOnlyPlaceholder = fileOnlyFallback ? `[Slack file: ${fileOnlyFallback}]` : undefined;

  const rawBody =
    [(message.text ?? "").trim(), attachmentContent?.text, mediaPlaceholder, fileOnlyPlaceholder]
      .filter(Boolean)
      .join("\n") || "";
  if (!rawBody) {
    return null;
  }

  const ackReaction = resolveAckReaction(cfg, route.agentId, {
    channel: "slack",
    accountId: account.accountId,
  });
  const ackReactionValue = ackReaction ?? "";

  const shouldAckReaction = () =>
    Boolean(
      ackReaction &&
      shouldAckReactionGate({
        scope: ctx.ackReactionScope as AckReactionScope | undefined,
        isDirect: isDirectMessage,
        isGroup: isRoomish,
        isMentionableGroup: isRoom,
        requireMention: Boolean(shouldRequireMention),
        canDetectMention,
        effectiveWasMentioned,
        shouldBypassMention: mentionGate.shouldBypassMention,
      }),
    );

  const ackReactionMessageTs = message.ts;
  const ackReactionPromise =
    shouldAckReaction() && ackReactionMessageTs && ackReactionValue
      ? reactSlackMessage(message.channel, ackReactionMessageTs, ackReactionValue, {
          token: ctx.botToken,
          client: ctx.app.client,
        }).then(
          () => true,
          (err) => {
            logVerbose(`slack react failed for channel ${message.channel}: ${String(err)}`);
            return false;
          },
        )
      : null;

  const roomLabel = channelName ? `#${channelName}` : `#${message.channel}`;
  const preview = rawBody.replace(/\s+/g, " ").slice(0, 160);
  const inboundLabel = isDirectMessage
    ? `Slack DM from ${senderName}`
    : `Slack message in ${roomLabel} from ${senderName}`;
  const slackFrom = isDirectMessage
    ? `slack:${message.user}`
    : isRoom
      ? `slack:channel:${message.channel}`
      : `slack:group:${message.channel}`;

  enqueueSystemEvent(`${inboundLabel}: ${preview}`, {
    sessionKey,
    contextKey: `slack:message:${message.channel}:${message.ts ?? "unknown"}`,
  });

  const envelopeFrom =
    resolveConversationLabel({
      ChatType: isDirectMessage ? "direct" : "channel",
      SenderName: senderName,
      GroupSubject: isRoomish ? roomLabel : undefined,
      From: slackFrom,
    }) ?? (isDirectMessage ? senderName : roomLabel);
  const threadInfo =
    isThreadReply && threadTs
      ? ` thread_ts: ${threadTs}${message.parent_user_id ? ` parent_user_id: ${message.parent_user_id}` : ""}`
      : "";
  const textWithId = `${rawBody}\n[slack message id: ${message.ts} channel: ${message.channel}${threadInfo}]`;
  const storePath = resolveStorePath(ctx.cfg.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = resolveEnvelopeFormatOptions(ctx.cfg);
  const previousTimestamp = readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = formatInboundEnvelope({
    channel: "Slack",
    from: envelopeFrom,
    timestamp: message.ts ? Math.round(Number(message.ts) * 1000) : undefined,
    body: textWithId,
    chatType: isDirectMessage ? "direct" : "channel",
    sender: { name: senderName, id: senderId },
    previousTimestamp,
    envelope: envelopeOptions,
  });

  let combinedBody = body;
  if (isRoomish && ctx.historyLimit > 0) {
    combinedBody = buildPendingHistoryContextFromMap({
      historyMap: ctx.channelHistories,
      historyKey,
      limit: ctx.historyLimit,
      currentMessage: combinedBody,
      formatEntry: (entry) =>
        formatInboundEnvelope({
          channel: "Slack",
          from: roomLabel,
          timestamp: entry.timestamp,
          body: `${entry.body}${
            entry.messageId ? ` [id:${entry.messageId} channel:${message.channel}]` : ""
          }`,
          chatType: "channel",
          senderLabel: entry.sender,
          envelope: envelopeOptions,
        }),
    });
  }

  const slackTo = isDirectMessage ? `user:${message.user}` : `channel:${message.channel}`;

  const { untrustedChannelMetadata, groupSystemPrompt } = resolveSlackRoomContextHints({
    isRoomish,
    channelInfo,
    channelConfig,
  });

  let threadStarterBody: string | undefined;
  let threadHistoryBody: string | undefined;
  let threadSessionPreviousTimestamp: number | undefined;
  let threadLabel: string | undefined;
  let threadStarterMedia: Awaited<ReturnType<typeof resolveSlackMedia>> = null;
  if (isThreadReply && threadTs) {
    const starter = await resolveSlackThreadStarter({
      channelId: message.channel,
      threadTs,
      client: ctx.app.client,
    });
    if (starter?.text) {
      // Keep thread starter as raw text; metadata is provided out-of-band in the system prompt.
      threadStarterBody = starter.text;
      const snippet = starter.text.replace(/\s+/g, " ").slice(0, 80);
      threadLabel = `Slack thread ${roomLabel}${snippet ? `: ${snippet}` : ""}`;
      // If current message has no files but thread starter does, fetch starter's files
      if (!effectiveDirectMedia && starter.files && starter.files.length > 0) {
        threadStarterMedia = await resolveSlackMedia({
          files: starter.files,
          token: ctx.botToken,
          maxBytes: ctx.mediaMaxBytes,
        });
        if (threadStarterMedia) {
          const starterPlaceholders = threadStarterMedia.map((m) => m.placeholder).join(", ");
          logVerbose(
            `slack: hydrated thread starter file ${starterPlaceholders} from root message`,
          );
        }
      }
    } else {
      threadLabel = `Slack thread ${roomLabel}`;
    }

    // Fetch full thread history for new thread sessions
    // This provides context of previous messages (including bot replies) in the thread
    // Use the thread session key (not base session key) to determine if this is a new session
    const threadInitialHistoryLimit = account.config?.thread?.initialHistoryLimit ?? 20;
    threadSessionPreviousTimestamp = readSessionUpdatedAt({
      storePath,
      sessionKey, // Thread-specific session key
    });
    if (threadInitialHistoryLimit > 0) {
      const threadHistory = await resolveSlackThreadHistory({
        channelId: message.channel,
        threadTs,
        client: ctx.app.client,
        currentMessageTs: message.ts,
        limit: threadInitialHistoryLimit,
      });

      if (threadHistory.length > 0) {
        // Batch resolve user names to avoid N sequential API calls
        const uniqueUserIds = [
          ...new Set(threadHistory.map((m) => m.userId).filter((id): id is string => Boolean(id))),
        ];
        const userMap = new Map<string, { name?: string }>();
        await Promise.all(
          uniqueUserIds.map(async (id) => {
            const user = await ctx.resolveUserName(id);
            if (user) {
              userMap.set(id, user);
            }
          }),
        );

        const historyParts: string[] = [];
        for (const historyMsg of threadHistory) {
          const msgUser = historyMsg.userId ? userMap.get(historyMsg.userId) : null;
          const msgSenderName =
            msgUser?.name ?? (historyMsg.botId ? `Bot (${historyMsg.botId})` : "Unknown");
          const isBot = Boolean(historyMsg.botId);
          const role = isBot ? "assistant" : "user";
          const msgWithId = `${historyMsg.text}\n[slack message id: ${historyMsg.ts ?? "unknown"} channel: ${message.channel}]`;
          historyParts.push(
            formatInboundEnvelope({
              channel: "Slack",
              from: `${msgSenderName} (${role})`,
              timestamp: historyMsg.ts ? Math.round(Number(historyMsg.ts) * 1000) : undefined,
              body: msgWithId,
              chatType: "channel",
              envelope: envelopeOptions,
            }),
          );
        }
        threadHistoryBody = historyParts.join("\n\n");
        logVerbose(
          `slack: populated thread history with ${threadHistory.length} messages for new session`,
        );
      }
    }
  }

  // Use direct media (including forwarded attachment media) if available, else thread starter media
  const effectiveMedia = effectiveDirectMedia ?? threadStarterMedia;
  const firstMedia = effectiveMedia?.[0];

  const inboundHistory =
    isRoomish && ctx.historyLimit > 0
      ? (ctx.channelHistories.get(historyKey) ?? []).map((entry) => ({
          sender: entry.sender,
          body: entry.body,
          timestamp: entry.timestamp,
        }))
      : undefined;

  const ctxPayload = finalizeInboundContext({
    Body: combinedBody,
    BodyForAgent: rawBody,
    InboundHistory: inboundHistory,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: slackFrom,
    To: slackTo,
    SessionKey: sessionKey,
    AccountId: route.accountId,
    ChatType: isDirectMessage ? "direct" : "channel",
    ConversationLabel: envelopeFrom,
    GroupSubject: isRoomish ? roomLabel : undefined,
    GroupSystemPrompt: isRoomish ? groupSystemPrompt : undefined,
    UntrustedContext: untrustedChannelMetadata ? [untrustedChannelMetadata] : undefined,
    SenderName: senderName,
    SenderId: senderId,
    Provider: "slack" as const,
    Surface: "slack" as const,
    MessageSid: message.ts,
    ReplyToId: threadContext.replyToId,
    // Preserve thread context for routed tool notifications.
    MessageThreadId: threadContext.messageThreadId,
    ParentSessionKey: threadKeys.parentSessionKey,
    ThreadStarterBody: threadStarterBody,
    ThreadHistoryBody: threadHistoryBody,
    IsFirstThreadTurn:
      isThreadReply && threadTs && !threadSessionPreviousTimestamp ? true : undefined,
    ThreadLabel: threadLabel,
    Timestamp: message.ts ? Math.round(Number(message.ts) * 1000) : undefined,
    WasMentioned: isRoomish ? effectiveWasMentioned : undefined,
    MediaPath: firstMedia?.path,
    MediaType: firstMedia?.contentType,
    MediaUrl: firstMedia?.path,
    MediaPaths:
      effectiveMedia && effectiveMedia.length > 0 ? effectiveMedia.map((m) => m.path) : undefined,
    MediaUrls:
      effectiveMedia && effectiveMedia.length > 0 ? effectiveMedia.map((m) => m.path) : undefined,
    MediaTypes:
      effectiveMedia && effectiveMedia.length > 0
        ? effectiveMedia.map((m) => m.contentType ?? "")
        : undefined,
    CommandAuthorized: commandAuthorized,
    OriginatingChannel: "slack" as const,
    OriginatingTo: slackTo,
  }) satisfies FinalizedMsgContext;

  await recordInboundSession({
    storePath,
    sessionKey,
    ctx: ctxPayload,
    updateLastRoute: isDirectMessage
      ? {
          sessionKey: route.mainSessionKey,
          channel: "slack",
          to: `user:${message.user}`,
          accountId: route.accountId,
          threadId: threadContext.messageThreadId,
        }
      : undefined,
    onRecordError: (err) => {
      ctx.logger.warn(
        {
          error: String(err),
          storePath,
          sessionKey,
        },
        "failed updating session meta",
      );
    },
  });

  const replyTarget = ctxPayload.To ?? undefined;
  if (!replyTarget) {
    return null;
  }

  if (shouldLogVerbose()) {
    logVerbose(`slack inbound: channel=${message.channel} from=${slackFrom} preview="${preview}"`);
  }

  return {
    ctx,
    account,
    message,
    route,
    channelConfig,
    replyTarget,
    ctxPayload,
    replyToMode,
    isDirectMessage,
    isRoomish,
    historyKey,
    preview,
    ackReactionMessageTs,
    ackReactionValue,
    ackReactionPromise,
  };
}
