import crypto from "node:crypto";
import { ChannelType, type RequestClient } from "@buape/carbon";
import { resolveAckReaction, resolveHumanDelayConfig } from "../../agents/identity.js";
import { AGENT_LANE_NESTED } from "../../agents/lanes.js";
import { EmbeddedBlockChunker } from "../../agents/pi-embedded-block-chunker.js";
import { createAndStartFlow } from "../../agents/tools/a2a-job-orchestrator.js";
import {
  buildRequesterContextSummary,
  buildAgentToAgentMessageContext,
  resolvePingPongTurns,
} from "../../agents/tools/sessions-send-helpers.js";
import { resolveChunkMode } from "../../auto-reply/chunk.js";
import { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import { formatInboundEnvelope, resolveEnvelopeFormatOptions } from "../../auto-reply/envelope.js";
import {
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
} from "../../auto-reply/reply/history.js";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import { createReplyDispatcherWithTyping } from "../../auto-reply/reply/reply-dispatcher.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { shouldAckReaction as shouldAckReactionGate } from "../../channels/ack-reactions.js";
import { logTypingFailure, logAckFailure } from "../../channels/logging.js";
import { createReplyPrefixOptions } from "../../channels/reply-prefix.js";
import { recordInboundSession } from "../../channels/session.js";
import {
  DEFAULT_TIMING,
  createStatusReactionController,
  type StatusReactionAdapter,
} from "../../channels/status-reactions.js";
import { createTypingCallbacks } from "../../channels/typing.js";
import { loadConfig } from "../../config/config.js";
import { isDangerousNameMatchingEnabled } from "../../config/dangerous-name-matching.js";
import { resolveDiscordPreviewStreamMode } from "../../config/discord-preview-streaming.js";
import { resolveMarkdownTableMode } from "../../config/markdown-tables.js";
import { readSessionUpdatedAt, resolveStorePath } from "../../config/sessions.js";
import { callGateway } from "../../gateway/call.js";
import { danger, logVerbose, shouldLogVerbose } from "../../globals.js";
import { emit } from "../../infra/events/bus.js";
import { EVENT_TYPES } from "../../infra/events/schemas.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { convertMarkdownTables } from "../../markdown/tables.js";
import { getAgentScopedMediaLocalRoots } from "../../media/local-roots.js";
import { buildAgentSessionKey } from "../../routing/resolve-route.js";
import { resolveThreadSessionKeys } from "../../routing/session-key.js";
import { buildUntrustedChannelMetadata as _buildUntrustedChannelMetadata } from "../../security/channel-metadata.js";
import { stripReasoningTagsFromText } from "../../shared/text/reasoning-tags.js";
import { truncateUtf16Safe } from "../../utils.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { chunkDiscordTextWithMode } from "../chunk.js";
import { markDmResponded, resolveDmRetryConfig } from "../dm-retry/index.js";
import { resolveDiscordDraftStreamingChunking } from "../draft-chunking.js";
import { createDiscordDraftStream } from "../draft-stream.js";
import { reactMessageDiscord, removeReactionDiscord } from "../send.js";
import { editMessageDiscord } from "../send.messages.js";
import { normalizeDiscordSlug } from "./allow-list.js";
import { resolveTimestampMs } from "./format.js";
import { buildDiscordInboundAccessContext } from "./inbound-context.js";
import type { DiscordMessagePreflightContext } from "./message-handler.preflight.js";
import {
  buildDiscordMediaPayload,
  resolveDiscordMessageText,
  resolveForwardedMediaList,
  resolveMediaList,
} from "./message-utils.js";
import { buildDirectLabel, buildGuildLabel, resolveReplyContext } from "./reply-context.js";
import { deliverDiscordReply } from "./reply-delivery.js";
import { getAgentIdForBot, isSiblingBot } from "./sibling-bots.js";
import {
  isThreadParticipant,
  registerThreadParticipant,
  touchThreadActivity,
} from "./thread-participants.js";
import { resolveDiscordAutoThreadReplyPlan, resolveDiscordThreadStarter } from "./threading.js";
import { sendTyping } from "./typing.js";

const a2aLog = createSubsystemLogger("discord/a2a-auto-route");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const DISCORD_TYPING_MAX_DURATION_MS = 20 * 60_000;

function isProcessAborted(abortSignal?: AbortSignal): boolean {
  return Boolean(abortSignal?.aborted);
}

export async function processDiscordMessage(ctx: DiscordMessagePreflightContext) {
  const {
    cfg,
    discordConfig,
    accountId,
    token,
    runtime,
    guildHistories,
    historyLimit,
    mediaMaxBytes,
    textLimit,
    replyToMode,
    ackReactionScope,
    message,
    author,
    sender,
    data,
    client,
    channelInfo,
    channelName,
    messageChannelId,
    isGuildMessage,
    isDirectMessage,
    isGroupDm,
    baseText,
    messageText,
    shouldRequireMention,
    canDetectMention,
    effectiveWasMentioned,
    shouldBypassMention,
    threadChannel,
    threadParentId,
    threadParentName,
    threadParentType,
    threadName,
    displayChannelSlug,
    guildInfo,
    guildSlug,
    channelConfig,
    baseSessionKey,
    route,
    commandAuthorized,
    boundSessionKey,
    threadBindings,
    discordRestFetch,
    abortSignal,
  } = ctx;
  if (isProcessAborted(abortSignal)) {
    return;
  }

  const ssrfPolicy = cfg.browser?.ssrfPolicy;
  const mediaList = await resolveMediaList(message, mediaMaxBytes, discordRestFetch, ssrfPolicy);
  if (isProcessAborted(abortSignal)) {
    return;
  }
  const forwardedMediaList = await resolveForwardedMediaList(
    message,
    mediaMaxBytes,
    discordRestFetch,
    ssrfPolicy,
  );
  if (isProcessAborted(abortSignal)) {
    return;
  }
  mediaList.push(...forwardedMediaList);
  const text = messageText;
  if (!text) {
    logVerbose("discord: drop message " + message.id + " (empty content)");
    return;
  }

  const resolvedMessageChannelId = messageChannelId ?? message.channelId;

  // ── A2A Auto-Routing ──────────────────────────────────────────────
  // When a sibling bot @mentions us in a main channel, route through the
  // A2A flow.  In threads, Handler/Observer routing applies: thread
  // participants and mentioned bots process normally (HANDLER), others
  // are silently skipped (OBSERVER).
  if (isSiblingBot(author.id) && isGuildMessage && ctx.botUserId) {
    if (threadChannel) {
      const amIParticipant = isThreadParticipant(resolvedMessageChannelId, ctx.botUserId);
      const amIMentioned = message.mentionedUsers?.some(
        (user: { id: string }) => user.id === ctx.botUserId,
      );

      if (amIParticipant || amIMentioned) {
        // HANDLER — I'm a thread participant or was mentioned
        if (amIMentioned && !amIParticipant) {
          registerThreadParticipant(resolvedMessageChannelId, ctx.botUserId);
        }
        touchThreadActivity(resolvedMessageChannelId);
        // Fall through to normal message processing (don't return)
        // Skip A2A auto-routing for thread participants
      } else {
        // OBSERVER — not a participant, record and skip
        logVerbose(`discord: observer mode for sibling bot in thread ${resolvedMessageChannelId}`);
        return;
      }
    } else {
      // Main channel: route through A2A flow
      const senderAgentId = getAgentIdForBot(author.id);
      const mentionsUs = message.mentionedUsers?.some(
        (user: { id: string }) => user.id === ctx.botUserId,
      );
      if (senderAgentId && mentionsUs) {
        try {
          const freshCfg = loadConfig();

          // Build sender's session key for the channel where the message originated
          const senderSessionKey = buildAgentSessionKey({
            agentId: senderAgentId,
            channel: "discord",
            peer: { kind: "channel", id: resolvedMessageChannelId },
          });

          // Target is the receiving agent (us) — session key from preflight route
          const targetSessionKey = route.sessionKey;

          const _requesterContext = await buildRequesterContextSummary(senderSessionKey);

          const enrichedContext = buildAgentToAgentMessageContext({
            requesterSessionKey: senderSessionKey,
            requesterChannel: "discord",
            targetSessionKey,
          });

          const cleanMessage = (baseText ?? text)
            .replace(new RegExp(`<@!?${ctx.botUserId}>`, "g"), "")
            .trim();

          const maxTurns = resolvePingPongTurns(freshCfg);
          const idempotencyKey = crypto.randomUUID();

          a2aLog.info("auto-routing sibling bot mention via A2A", {
            senderAgentId,
            senderSessionKey,
            targetSessionKey,
            channelId: resolvedMessageChannelId,
            maxTurns,
          });

          const conversationId = crypto.randomUUID();

          // Emit a2a.auto_route event for task-hub visibility
          emit({
            type: EVENT_TYPES.A2A_AUTO_ROUTE,
            agentId: senderAgentId,
            ts: Date.now(),
            data: {
              senderAgentId,
              targetAgentId: route.agentId,
              channelId: resolvedMessageChannelId,
              maxTurns,
              message: (cleanMessage || text).slice(0, 200),
              conversationId,
            },
          });

          const response = await callGateway<{ runId: string }>({
            method: "agent",
            params: {
              message: cleanMessage || text,
              sessionKey: targetSessionKey,
              idempotencyKey,
              deliver: false,
              channel: INTERNAL_MESSAGE_CHANNEL,
              lane: AGENT_LANE_NESTED,
              extraSystemPrompt: enrichedContext,
              inputProvenance: {
                kind: "inter_session",
                sourceSessionKey: senderSessionKey,
                sourceChannel: "discord",
                sourceTool: "discord_a2a_auto_route",
              },
            },
            timeoutMs: 10_000,
          });

          const runId =
            typeof response?.runId === "string" && response.runId ? response.runId : idempotencyKey;

          void createAndStartFlow({
            jobId: runId,
            targetSessionKey,
            displayKey: targetSessionKey,
            message: cleanMessage || text,
            announceTimeoutMs: 120_000,
            maxPingPongTurns: maxTurns,
            requesterSessionKey: senderSessionKey,
            requesterChannel: "discord",
            waitRunId: runId,
            conversationId,
          }).catch((err) => {
            a2aLog.warn("A2A auto-route flow failed", {
              error: err instanceof Error ? err.message : String(err),
              senderAgentId,
              targetSessionKey,
            });
          });

          return; // Skip normal message processing
        } catch (err) {
          // Graceful fallback: log and continue to normal processing
          a2aLog.warn("A2A auto-routing failed, falling back to normal processing", {
            error: err instanceof Error ? err.message : String(err),
            authorId: author.id,
            channelId: resolvedMessageChannelId,
          });
        }
      }
    }
  }
  // ── End A2A Auto-Routing ──────────────────────────────────────────
  const boundThreadId = ctx.threadBinding?.conversation?.conversationId?.trim();
  if (boundThreadId && typeof threadBindings.touchThread === "function") {
    threadBindings.touchThread({ threadId: boundThreadId });
  }
  const ackReaction = resolveAckReaction(cfg, route.agentId, {
    channel: "discord",
    accountId,
  });
  const removeAckAfterReply = cfg.messages?.removeAckAfterReply ?? false;
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(cfg, route.agentId);
  const shouldAckReaction = () =>
    Boolean(
      ackReaction &&
      shouldAckReactionGate({
        scope: ackReactionScope,
        isDirect: isDirectMessage,
        isGroup: isGuildMessage || isGroupDm,
        isMentionableGroup: isGuildMessage,
        requireMention: Boolean(shouldRequireMention),
        canDetectMention,
        effectiveWasMentioned,
        shouldBypassMention,
      }),
    );
  const statusReactionsEnabled = shouldAckReaction();
  // Discord outbound helpers expect Carbon's request client shape explicitly.
  const discordRest = client.rest as unknown as RequestClient;
  const discordAdapter: StatusReactionAdapter = {
    setReaction: async (emoji) => {
      await reactMessageDiscord(messageChannelId, message.id, emoji, {
        rest: discordRest,
      });
    },
    removeReaction: async (emoji) => {
      await removeReactionDiscord(messageChannelId, message.id, emoji, {
        rest: discordRest,
      });
    },
  };
  const statusReactions = createStatusReactionController({
    enabled: statusReactionsEnabled,
    adapter: discordAdapter,
    initialEmoji: ackReaction,
    emojis: cfg.messages?.statusReactions?.emojis,
    timing: cfg.messages?.statusReactions?.timing,
    onError: (err) => {
      logAckFailure({
        log: logVerbose,
        channel: "discord",
        target: `${messageChannelId}/${message.id}`,
        error: err,
      });
    },
  });
  if (statusReactionsEnabled) {
    void statusReactions.setQueued();
  }

  const fromLabel = isDirectMessage
    ? buildDirectLabel(author)
    : buildGuildLabel({
        guild: data.guild ?? undefined,
        channelName: channelName ?? resolvedMessageChannelId,
        channelId: resolvedMessageChannelId,
      });
  const senderLabel = sender.label;
  const isForumParent =
    threadParentType === ChannelType.GuildForum || threadParentType === ChannelType.GuildMedia;
  const forumParentSlug =
    isForumParent && threadParentName ? normalizeDiscordSlug(threadParentName) : "";
  const threadChannelId = threadChannel?.id;
  const isForumStarter =
    Boolean(threadChannelId && isForumParent && forumParentSlug) && message.id === threadChannelId;
  const forumContextLine = isForumStarter ? `[Forum parent: #${forumParentSlug}]` : null;
  const groupChannel = isGuildMessage && displayChannelSlug ? `#${displayChannelSlug}` : undefined;
  const groupSubject = isDirectMessage ? undefined : groupChannel;
  const senderName = sender.isPluralKit
    ? (sender.name ?? author.username)
    : (data.member?.nickname ?? author.globalName ?? author.username);
  const senderUsername = sender.isPluralKit
    ? (sender.tag ?? sender.name ?? author.username)
    : author.username;
  const senderTag = sender.tag;
  const { groupSystemPrompt, ownerAllowFrom, untrustedContext } = buildDiscordInboundAccessContext({
    channelConfig,
    guildInfo,
    sender: { id: sender.id, name: sender.name, tag: sender.tag },
    allowNameMatching: isDangerousNameMatchingEnabled(discordConfig),
    isGuild: isGuildMessage,
    channelTopic: channelInfo?.topic,
  });
  const storePath = resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = resolveEnvelopeFormatOptions(cfg);
  const previousTimestamp = readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  let combinedBody = formatInboundEnvelope({
    channel: "Discord",
    from: fromLabel,
    timestamp: resolveTimestampMs(message.timestamp),
    body: text,
    chatType: isDirectMessage ? "direct" : "channel",
    senderLabel,
    previousTimestamp,
    envelope: envelopeOptions,
  });
  const shouldIncludeChannelHistory =
    !isDirectMessage && !(isGuildMessage && channelConfig?.autoThread && !threadChannel);
  if (shouldIncludeChannelHistory) {
    combinedBody = buildPendingHistoryContextFromMap({
      historyMap: guildHistories,
      historyKey: resolvedMessageChannelId,
      limit: historyLimit,
      currentMessage: combinedBody,
      formatEntry: (entry) =>
        formatInboundEnvelope({
          channel: "Discord",
          from: fromLabel,
          timestamp: entry.timestamp,
          body: `${entry.body} [id:${entry.messageId ?? "unknown"} channel:${resolvedMessageChannelId}]`,
          chatType: "channel",
          senderLabel: entry.sender,
          envelope: envelopeOptions,
        }),
    });
  }
  const replyContext = resolveReplyContext(message, resolveDiscordMessageText);
  if (forumContextLine) {
    combinedBody = `${combinedBody}\n${forumContextLine}`;
  }

  let threadStarterBody: string | undefined;
  let threadLabel: string | undefined;
  let parentSessionKey: string | undefined;
  if (threadChannel) {
    const includeThreadStarter = channelConfig?.includeThreadStarter !== false;
    if (includeThreadStarter) {
      const starter = await resolveDiscordThreadStarter({
        channel: threadChannel,
        client,
        parentId: threadParentId,
        parentType: threadParentType,
        resolveTimestampMs,
      });
      if (starter?.text) {
        // Keep thread starter as raw text; metadata is provided out-of-band in the system prompt.
        threadStarterBody = starter.text;
      }
    }
    const parentName = threadParentName ?? "parent";
    threadLabel = threadName
      ? `Discord thread #${normalizeDiscordSlug(parentName)} › ${threadName}`
      : `Discord thread #${normalizeDiscordSlug(parentName)}`;
    if (threadParentId) {
      parentSessionKey = buildAgentSessionKey({
        agentId: route.agentId,
        channel: route.channel,
        peer: { kind: "channel", id: threadParentId },
      });
    }
  }
  const mediaPayload = buildDiscordMediaPayload(mediaList);
  const threadKeys = resolveThreadSessionKeys({
    baseSessionKey,
    threadId: threadChannel ? resolvedMessageChannelId : undefined,
    parentSessionKey,
    useSuffix: false,
  });
  const replyPlan = await resolveDiscordAutoThreadReplyPlan({
    client,
    message,
    isGuildMessage,
    channelConfig,
    threadChannel,
    channelType: channelInfo?.type,
    baseText: baseText ?? "",
    combinedBody,
    replyToMode,
    agentId: route.agentId,
    channel: route.channel,
  });
  const deliverTarget = replyPlan.deliverTarget;
  const replyTarget = replyPlan.replyTarget;
  const replyReference = replyPlan.replyReference;
  const autoThreadContext = replyPlan.autoThreadContext;

  const effectiveFrom = isDirectMessage
    ? `discord:${author.id}`
    : (autoThreadContext?.From ?? `discord:channel:${resolvedMessageChannelId}`);
  const effectiveTo = autoThreadContext?.To ?? replyTarget;
  if (!effectiveTo) {
    runtime.error?.(danger("discord: missing reply target"));
    return;
  }
  // Keep DM routes user-addressed so follow-up sends resolve direct session keys.
  const lastRouteTo = isDirectMessage ? `user:${author.id}` : effectiveTo;

  const inboundHistory =
    shouldIncludeChannelHistory && historyLimit > 0
      ? (guildHistories.get(resolvedMessageChannelId) ?? []).map((entry) => ({
          sender: entry.sender,
          body: entry.body,
          timestamp: entry.timestamp,
        }))
      : undefined;

  const ctxPayload = finalizeInboundContext({
    Body: combinedBody,
    BodyForAgent: baseText ?? text,
    InboundHistory: inboundHistory,
    RawBody: baseText,
    CommandBody: baseText,
    From: effectiveFrom,
    To: effectiveTo,
    SessionKey: boundSessionKey ?? autoThreadContext?.SessionKey ?? threadKeys.sessionKey,
    MessageThreadId: boundSessionKey && threadChannel ? resolvedMessageChannelId : undefined,
    AccountId: route.accountId,
    ChatType: isDirectMessage ? "direct" : "channel",
    ConversationLabel: fromLabel,
    SenderName: senderName,
    SenderId: sender.id,
    SenderUsername: senderUsername,
    SenderTag: senderTag,
    GroupSubject: groupSubject,
    GroupChannel: groupChannel,
    UntrustedContext: untrustedContext,
    GroupSystemPrompt: isGuildMessage ? groupSystemPrompt : undefined,
    GroupSpace: isGuildMessage ? (guildInfo?.id ?? guildSlug) || undefined : undefined,
    OwnerAllowFrom: ownerAllowFrom,
    Provider: "discord" as const,
    Surface: "discord" as const,
    WasMentioned: effectiveWasMentioned,
    MessageSid: message.id,
    ReplyToId: replyContext?.id,
    ReplyToBody: replyContext?.body,
    ReplyToSender: replyContext?.sender,
    ParentSessionKey: autoThreadContext?.ParentSessionKey ?? threadKeys.parentSessionKey,
    ThreadStarterBody: threadStarterBody,
    ThreadLabel: threadLabel,
    Timestamp: resolveTimestampMs(message.timestamp),
    ...mediaPayload,
    CommandAuthorized: commandAuthorized,
    CommandSource: "text" as const,
    // Originating channel for reply routing.
    OriginatingChannel: "discord" as const,
    OriginatingTo: autoThreadContext?.OriginatingTo ?? replyTarget,
  });
  const persistedSessionKey = ctxPayload.SessionKey ?? route.sessionKey;

  await recordInboundSession({
    storePath,
    sessionKey: persistedSessionKey,
    ctx: ctxPayload,
    updateLastRoute: {
      sessionKey: persistedSessionKey,
      channel: "discord",
      to: lastRouteTo,
      accountId: route.accountId,
    },
    onRecordError: (err) => {
      logVerbose(`discord: failed updating session meta: ${String(err)}`);
    },
  });

  if (isDirectMessage) {
    const dmRetryConfig = resolveDmRetryConfig(cfg, accountId);
    if (dmRetryConfig.enabled) {
      try {
        const count = await markDmResponded(resolvedMessageChannelId);
        if (count > 0) {
          logVerbose(
            `dm-retry: marked ${count} DM(s) as responded for channel ${resolvedMessageChannelId}`,
          );
        }
      } catch (err) {
        logVerbose(`dm-retry: failed to mark DM responded: ${String(err)}`);
      }
    }
  }

  if (shouldLogVerbose()) {
    const preview = truncateUtf16Safe(combinedBody, 200).replace(/\n/g, "\\n");
    logVerbose(
      `discord inbound: channel=${resolvedMessageChannelId} deliver=${deliverTarget} from=${ctxPayload.From} preview="${preview}"`,
    );
  }

  const typingChannelId = deliverTarget.startsWith("channel:")
    ? deliverTarget.slice("channel:".length)
    : resolvedMessageChannelId;

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId: route.agentId,
    channel: "discord",
    accountId: route.accountId,
  });
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "discord",
    accountId,
  });
  const chunkMode = resolveChunkMode(cfg, "discord", accountId);

  const typingCallbacks = createTypingCallbacks({
    start: () => sendTyping({ client, channelId: typingChannelId }),
    onStartError: (err) => {
      logTypingFailure({
        log: logVerbose,
        channel: "discord",
        target: typingChannelId,
        error: err,
      });
    },
    // Long tool-heavy runs are expected on Discord; keep heartbeats alive.
    maxDurationMs: DISCORD_TYPING_MAX_DURATION_MS,
  });

  // --- Discord draft stream (edit-based preview streaming) ---
  const discordStreamMode = resolveDiscordPreviewStreamMode(
    discordConfig as { streamMode?: unknown; streaming?: unknown } | undefined,
  );
  const draftMaxChars = Math.min(textLimit, 2000);
  const accountBlockStreamingEnabled =
    typeof discordConfig?.blockStreaming === "boolean"
      ? discordConfig.blockStreaming
      : cfg.agents?.defaults?.blockStreamingDefault === "on";
  const canStreamDraft = discordStreamMode !== "off" && !accountBlockStreamingEnabled;
  const draftReplyToMessageId = () => replyReference.use();
  const deliverChannelId = deliverTarget.startsWith("channel:")
    ? deliverTarget.slice("channel:".length)
    : messageChannelId;
  const draftStream = canStreamDraft
    ? createDiscordDraftStream({
        rest: client.rest,
        channelId: deliverChannelId,
        maxChars: draftMaxChars,
        replyToMessageId: draftReplyToMessageId,
        minInitialChars: 30,
        throttleMs: 1200,
        log: logVerbose,
        warn: logVerbose,
      })
    : undefined;
  const draftChunking =
    draftStream && discordStreamMode === "block"
      ? resolveDiscordDraftStreamingChunking(cfg, accountId)
      : undefined;
  const shouldSplitPreviewMessages = discordStreamMode === "block";
  const draftChunker = draftChunking ? new EmbeddedBlockChunker(draftChunking) : undefined;
  let lastPartialText = "";
  let draftText = "";
  let _hasStreamedMessage = false;
  let finalizedViaPreviewMessage = false;

  const resolvePreviewFinalText = (text?: string) => {
    if (typeof text !== "string") {
      return undefined;
    }
    const formatted = convertMarkdownTables(text, tableMode);
    const chunks = chunkDiscordTextWithMode(formatted, {
      maxChars: draftMaxChars,
      maxLines: discordConfig?.maxLinesPerMessage,
      chunkMode,
    });
    if (!chunks.length && formatted) {
      chunks.push(formatted);
    }
    if (chunks.length !== 1) {
      return undefined;
    }
    const trimmed = chunks[0].trim();
    if (!trimmed) {
      return undefined;
    }
    const currentPreviewText = discordStreamMode === "block" ? draftText : lastPartialText;
    if (
      currentPreviewText &&
      currentPreviewText.startsWith(trimmed) &&
      trimmed.length < currentPreviewText.length
    ) {
      return undefined;
    }
    return trimmed;
  };

  const updateDraftFromPartial = (text?: string) => {
    if (!draftStream || !text) {
      return;
    }
    // Strip reasoning/thinking tags that may leak through the stream.
    const cleaned = stripReasoningTagsFromText(text, { mode: "strict", trim: "both" });
    // Skip pure-reasoning messages (e.g. "Reasoning:\n…") that contain no answer text.
    if (!cleaned || cleaned.startsWith("Reasoning:\n")) {
      return;
    }
    if (cleaned === lastPartialText) {
      return;
    }
    _hasStreamedMessage = true;
    if (discordStreamMode === "partial") {
      // Keep the longer preview to avoid visible punctuation flicker.
      if (
        lastPartialText &&
        lastPartialText.startsWith(cleaned) &&
        cleaned.length < lastPartialText.length
      ) {
        return;
      }
      lastPartialText = cleaned;
      draftStream.update(cleaned);
      return;
    }

    let delta = cleaned;
    if (cleaned.startsWith(lastPartialText)) {
      delta = cleaned.slice(lastPartialText.length);
    } else {
      // Streaming buffer reset (or non-monotonic stream). Start fresh.
      draftChunker?.reset();
      draftText = "";
    }
    lastPartialText = cleaned;
    if (!delta) {
      return;
    }
    if (!draftChunker) {
      draftText = cleaned;
      draftStream.update(draftText);
      return;
    }
    draftChunker.append(delta);
    draftChunker.drain({
      force: false,
      emit: (chunk) => {
        draftText += chunk;
        draftStream.update(draftText);
      },
    });
  };

  const flushDraft = async () => {
    if (!draftStream) {
      return;
    }
    if (draftChunker?.hasBuffered()) {
      draftChunker.drain({
        force: true,
        emit: (chunk) => {
          draftText += chunk;
        },
      });
      draftChunker.reset();
      if (draftText) {
        draftStream.update(draftText);
      }
    }
    await draftStream.flush();
  };

  // When draft streaming is active, suppress block streaming to avoid double-streaming.
  const disableBlockStreamingForDraft = draftStream ? true : undefined;

  const { dispatcher, replyOptions, markDispatchIdle, markRunComplete } =
    createReplyDispatcherWithTyping({
      ...prefixOptions,
      humanDelay: resolveHumanDelayConfig(cfg, route.agentId),
      typingCallbacks,
      deliver: async (payload: ReplyPayload, info) => {
        if (isProcessAborted(abortSignal)) {
          return;
        }
        const isFinal = info.kind === "final";
        if (payload.isReasoning) {
          // Reasoning/thinking payloads should not be delivered to Discord.
          return;
        }
        if (draftStream && isFinal) {
          await flushDraft();
          const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
          const finalText = payload.text;
          const previewFinalText = resolvePreviewFinalText(finalText);
          const previewMessageId = draftStream.messageId();

          // Try to finalize via preview edit (text-only, fits in 2000 chars, not an error)
          const canFinalizeViaPreviewEdit =
            !finalizedViaPreviewMessage &&
            !hasMedia &&
            typeof previewFinalText === "string" &&
            typeof previewMessageId === "string" &&
            !payload.isError;

          if (canFinalizeViaPreviewEdit) {
            await draftStream.stop();
            if (isProcessAborted(abortSignal)) {
              return;
            }
            try {
              await editMessageDiscord(
                deliverChannelId,
                previewMessageId,
                { content: previewFinalText },
                { rest: client.rest },
              );
              finalizedViaPreviewMessage = true;
              replyReference.markSent();
              return;
            } catch (err) {
              logVerbose(
                `discord: preview final edit failed; falling back to standard send (${String(err)})`,
              );
            }
          }

          // Check if stop() flushed a message we can edit
          if (!finalizedViaPreviewMessage) {
            await draftStream.stop();
            if (isProcessAborted(abortSignal)) {
              return;
            }
            const messageIdAfterStop = draftStream.messageId();
            if (
              typeof messageIdAfterStop === "string" &&
              typeof previewFinalText === "string" &&
              !hasMedia &&
              !payload.isError
            ) {
              try {
                await editMessageDiscord(
                  deliverChannelId,
                  messageIdAfterStop,
                  { content: previewFinalText },
                  { rest: client.rest },
                );
                finalizedViaPreviewMessage = true;
                replyReference.markSent();
                return;
              } catch (err) {
                logVerbose(
                  `discord: post-stop preview edit failed; falling back to standard send (${String(err)})`,
                );
              }
            }
          }

          // Clear the preview and fall through to standard delivery
          if (!finalizedViaPreviewMessage) {
            await draftStream.clear();
          }
        }
        if (isProcessAborted(abortSignal)) {
          return;
        }

        const replyToId = replyReference.use();
        await deliverDiscordReply({
          replies: [payload],
          target: deliverTarget,
          token,
          accountId,
          rest: client.rest,
          runtime,
          replyToId,
          replyToMode: replyToMode === "off" ? undefined : replyToMode,
          textLimit,
          maxLinesPerMessage: discordConfig?.maxLinesPerMessage,
          tableMode,
          chunkMode,
          sessionKey: ctxPayload.SessionKey,
          threadBindings,
          mediaLocalRoots,
        });
        replyReference.markSent();
      },
      onError: (err, info) => {
        runtime.error?.(danger(`discord ${info.kind} reply failed: ${String(err)}`));
      },
      onReplyStart: async () => {
        if (isProcessAborted(abortSignal)) {
          return;
        }
        await typingCallbacks.onReplyStart();
        await statusReactions.setThinking();
      },
    });

  let dispatchResult: Awaited<ReturnType<typeof dispatchInboundMessage>> | null = null;
  let dispatchError = false;
  let dispatchAborted = false;
  try {
    if (isProcessAborted(abortSignal)) {
      dispatchAborted = true;
      return;
    }
    dispatchResult = await dispatchInboundMessage({
      ctx: ctxPayload,
      cfg,
      dispatcher,
      replyOptions: {
        ...replyOptions,
        abortSignal,
        skillFilter: channelConfig?.skills,
        disableBlockStreaming:
          disableBlockStreamingForDraft ??
          (typeof discordConfig?.blockStreaming === "boolean"
            ? !discordConfig.blockStreaming
            : undefined),
        onModelSelected,
        onReasoningStream: async () => {
          await statusReactions.setThinking();
        },
        onToolStart: async (payload) => {
          if (isProcessAborted(abortSignal)) {
            return;
          }
          await statusReactions.setTool(payload.name);
        },
        onPartialReply: draftStream
          ? async (payload: { text?: string }) => {
              updateDraftFromPartial(payload.text);
            }
          : undefined,
        onAssistantMessageStart:
          draftStream && shouldSplitPreviewMessages
            ? async () => {
                draftStream.forceNewMessage();
              }
            : undefined,
      },
    });
    if (isProcessAborted(abortSignal)) {
      dispatchAborted = true;
      return;
    }
  } catch (err) {
    if (isProcessAborted(abortSignal)) {
      dispatchAborted = true;
      return;
    }
    dispatchError = true;
    throw err;
  } finally {
    try {
      // Must stop() first to flush debounced content before clear() wipes state.
      await draftStream?.stop();
      if (!finalizedViaPreviewMessage) {
        await draftStream?.clear();
      }
    } catch (err) {
      // Draft cleanup should never keep typing alive.
      logVerbose(`discord: draft cleanup failed: ${String(err)}`);
    } finally {
      markRunComplete();
      markDispatchIdle();
    }
    if (statusReactionsEnabled) {
      if (dispatchAborted) {
        if (removeAckAfterReply) {
          void statusReactions.clear();
        } else {
          void statusReactions.restoreInitial();
        }
      } else {
        if (dispatchError) {
          await statusReactions.setError();
        } else {
          await statusReactions.setDone();
        }
        if (removeAckAfterReply) {
          void (async () => {
            await sleep(dispatchError ? DEFAULT_TIMING.errorHoldMs : DEFAULT_TIMING.doneHoldMs);
            await statusReactions.clear();
          })();
        } else {
          void statusReactions.restoreInitial();
        }
      }
    }
  }
  if (dispatchAborted) {
    return;
  }

  if (!dispatchResult?.queuedFinal) {
    if (isGuildMessage) {
      clearHistoryEntriesIfEnabled({
        historyMap: guildHistories,
        historyKey: resolvedMessageChannelId,
        limit: historyLimit,
      });
    }
    return;
  }
  if (shouldLogVerbose()) {
    const finalCount = dispatchResult.counts.final;
    logVerbose(
      `discord: delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${replyTarget}`,
    );
  }

  if (isGuildMessage) {
    clearHistoryEntriesIfEnabled({
      historyMap: guildHistories,
      historyKey: resolvedMessageChannelId,
      limit: historyLimit,
    });
  }
}
