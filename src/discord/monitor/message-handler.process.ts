import crypto from "node:crypto";
import type { User } from "@buape/carbon";
import { ChannelType } from "@buape/carbon";
import { resolveAckReaction, resolveHumanDelayConfig } from "../../agents/identity.js";
import { AGENT_LANE_NESTED } from "../../agents/lanes.js";
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
import { DEFAULT_EMOJIS, DEFAULT_TIMING } from "../../channels/status-reactions.js";
import { createTypingCallbacks } from "../../channels/typing.js";
import { loadConfig } from "../../config/config.js";
import { resolveMarkdownTableMode } from "../../config/markdown-tables.js";
import { readSessionUpdatedAt, resolveStorePath } from "../../config/sessions.js";
import { callGateway } from "../../gateway/call.js";
import { danger, logVerbose, shouldLogVerbose } from "../../globals.js";
import { emit } from "../../infra/events/bus.js";
import { EVENT_TYPES } from "../../infra/events/schemas.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { buildAgentSessionKey } from "../../routing/resolve-route.js";
import { resolveThreadSessionKeys } from "../../routing/session-key.js";
import { buildUntrustedChannelMetadata } from "../../security/channel-metadata.js";
import { truncateUtf16Safe } from "../../utils.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import { markDmResponded, resolveDmRetryConfig } from "../dm-retry/index.js";
import { createDiscordDraftStream } from "../draft-stream.js";
import { reactMessageDiscord, removeReactionDiscord } from "../send.js";
import { editMessageDiscord } from "../send.messages.js";
import { normalizeDiscordSlug, resolveDiscordOwnerAllowFrom } from "./allow-list.js";
import { resolveTimestampMs } from "./format.js";
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

const DISCORD_STATUS_THINKING_EMOJI = "🧠";
const DISCORD_STATUS_TOOL_EMOJI = "🛠️";
const DISCORD_STATUS_CODING_EMOJI = "💻";
const DISCORD_STATUS_WEB_EMOJI = "🌐";
const DISCORD_STATUS_DONE_HOLD_MS = 1500;
const DISCORD_STATUS_ERROR_HOLD_MS = 2500;

const CODING_STATUS_TOOL_TOKENS = [
  "exec",
  "process",
  "read",
  "write",
  "edit",
  "session_status",
  "bash",
];

const WEB_STATUS_TOOL_TOKENS = ["web_search", "web-search", "web_fetch", "web-fetch", "browser"];

function resolveToolStatusEmoji(toolName?: string): string {
  const normalized = toolName?.trim().toLowerCase() ?? "";
  if (!normalized) {
    return DISCORD_STATUS_TOOL_EMOJI;
  }
  if (WEB_STATUS_TOOL_TOKENS.some((token) => normalized.includes(token))) {
    return DISCORD_STATUS_WEB_EMOJI;
  }
  if (CODING_STATUS_TOOL_TOKENS.some((token) => normalized.includes(token))) {
    return DISCORD_STATUS_CODING_EMOJI;
  }
  return DISCORD_STATUS_TOOL_EMOJI;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createDiscordStatusReactionController(params: {
  enabled: boolean;
  channelId: string;
  messageId: string;
  initialEmoji: string;
  rest: unknown;
  emojis?: Record<string, string>;
  timing?: Record<string, number>;
  onError?: (err: unknown) => void;
}) {
  // Resolve effective emojis and timing from overrides, falling back to canonical defaults
  const eQueued = params.emojis?.queued ?? params.initialEmoji;
  const eThinking = params.emojis?.thinking ?? DISCORD_STATUS_THINKING_EMOJI;
  const eDone = params.emojis?.done ?? DEFAULT_EMOJIS.done;
  const eStallSoft = params.emojis?.stallSoft ?? DEFAULT_EMOJIS.stallSoft;
  const eStallHard = params.emojis?.stallHard ?? DEFAULT_EMOJIS.stallHard;
  const eError = params.emojis?.error ?? DEFAULT_EMOJIS.error;
  const tDebounce = params.timing?.debounceMs ?? DEFAULT_TIMING.debounceMs;
  const tStallSoft = params.timing?.stallSoftMs ?? DEFAULT_TIMING.stallSoftMs;
  const tStallHard = params.timing?.stallHardMs ?? DEFAULT_TIMING.stallHardMs;

  let activeEmoji: string | null = null;
  let chain: Promise<void> = Promise.resolve();
  let pendingEmoji: string | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let finished = false;
  let softStallTimer: ReturnType<typeof setTimeout> | null = null;
  let hardStallTimer: ReturnType<typeof setTimeout> | null = null;

  const enqueue = (work: () => Promise<void>) => {
    chain = chain.then(work).catch((err) => {
      logAckFailure({
        log: logVerbose,
        channel: "discord",
        target: `${params.channelId}/${params.messageId}`,
        error: err,
      });
    });
    return chain;
  };

  const clearStallTimers = () => {
    if (softStallTimer) {
      clearTimeout(softStallTimer);
      softStallTimer = null;
    }
    if (hardStallTimer) {
      clearTimeout(hardStallTimer);
      hardStallTimer = null;
    }
  };

  const clearPendingDebounce = () => {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    pendingEmoji = null;
  };

  const applyEmoji = (emoji: string) =>
    enqueue(async () => {
      if (!params.enabled || !emoji || activeEmoji === emoji) {
        return;
      }
      const previousEmoji = activeEmoji;
      await reactMessageDiscord(params.channelId, params.messageId, emoji, {
        rest: params.rest as never,
      });
      activeEmoji = emoji;
      if (previousEmoji && previousEmoji !== emoji) {
        await removeReactionDiscord(params.channelId, params.messageId, previousEmoji, {
          rest: params.rest as never,
        });
      }
    });

  const requestEmoji = (emoji: string, options?: { immediate?: boolean }) => {
    if (!params.enabled || !emoji) {
      return Promise.resolve();
    }
    if (options?.immediate) {
      clearPendingDebounce();
      return applyEmoji(emoji);
    }
    pendingEmoji = emoji;
    if (pendingTimer) {
      clearTimeout(pendingTimer);
    }
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      const emojiToApply = pendingEmoji;
      pendingEmoji = null;
      if (!emojiToApply || emojiToApply === activeEmoji) {
        return;
      }
      void applyEmoji(emojiToApply);
    }, tDebounce);
    return Promise.resolve();
  };

  const scheduleStallTimers = () => {
    if (!params.enabled || finished) {
      return;
    }
    clearStallTimers();
    softStallTimer = setTimeout(() => {
      if (finished) {
        return;
      }
      void requestEmoji(eStallSoft, { immediate: true });
    }, tStallSoft);
    hardStallTimer = setTimeout(() => {
      if (finished) {
        return;
      }
      void requestEmoji(eStallHard, { immediate: true });
    }, tStallHard);
  };

  const setPhase = (emoji: string) => {
    if (!params.enabled || finished) {
      return Promise.resolve();
    }
    scheduleStallTimers();
    return requestEmoji(emoji);
  };

  const setTerminal = async (emoji: string) => {
    if (!params.enabled) {
      return;
    }
    finished = true;
    clearStallTimers();
    await requestEmoji(emoji, { immediate: true });
  };

  const clear = async () => {
    if (!params.enabled) {
      return;
    }
    finished = true;
    clearStallTimers();
    clearPendingDebounce();
    await enqueue(async () => {
      const cleanupCandidates = new Set<string>([
        params.initialEmoji,
        activeEmoji ?? "",
        DISCORD_STATUS_THINKING_EMOJI,
        DISCORD_STATUS_TOOL_EMOJI,
        DISCORD_STATUS_CODING_EMOJI,
        DISCORD_STATUS_WEB_EMOJI,
        eDone,
        eError,
        eStallSoft,
        eStallHard,
      ]);
      activeEmoji = null;
      for (const emoji of cleanupCandidates) {
        if (!emoji) {
          continue;
        }
        try {
          await removeReactionDiscord(params.channelId, params.messageId, emoji, {
            rest: params.rest as never,
          });
        } catch (err) {
          logAckFailure({
            log: logVerbose,
            channel: "discord",
            target: `${params.channelId}/${params.messageId}`,
            error: err,
          });
        }
      }
    });
  };

  const restoreInitial = async () => {
    if (!params.enabled) {
      return;
    }
    finished = true;
    clearStallTimers();
    clearPendingDebounce();
    await requestEmoji(params.initialEmoji, { immediate: true });
  };

  return {
    setQueued: () => {
      scheduleStallTimers();
      return requestEmoji(eQueued, { immediate: true });
    },
    setThinking: () => setPhase(eThinking),
    setTool: (toolName?: string) => setPhase(resolveToolStatusEmoji(toolName)),
    setDone: () => setTerminal(eDone),
    setError: () => setTerminal(eError),
    clear,
    restoreInitial,
  };
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
  } = ctx;

  const mediaList = await resolveMediaList(message, mediaMaxBytes, discordRestFetch);
  const forwardedMediaList = await resolveForwardedMediaList(
    message,
    mediaMaxBytes,
    discordRestFetch,
  );
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
      const mentionsUs = message.mentionedUsers?.some((user: User) => user.id === ctx.botUserId);
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
  const statusReactions = createDiscordStatusReactionController({
    enabled: statusReactionsEnabled,
    channelId: messageChannelId,
    messageId: message.id,
    initialEmoji: ackReaction,
    rest: client.rest,
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
  const untrustedChannelMetadata = isGuildMessage
    ? buildUntrustedChannelMetadata({
        source: "discord",
        label: "Discord channel topic",
        entries: [channelInfo?.topic],
      })
    : undefined;
  const senderName = sender.isPluralKit
    ? (sender.name ?? author.username)
    : (data.member?.nickname ?? author.globalName ?? author.username);
  const senderUsername = sender.isPluralKit
    ? (sender.tag ?? sender.name ?? author.username)
    : author.username;
  const senderTag = sender.tag;
  const systemPromptParts = [channelConfig?.systemPrompt?.trim() || null].filter(
    (entry): entry is string => Boolean(entry),
  );
  const groupSystemPrompt =
    systemPromptParts.length > 0 ? systemPromptParts.join("\n\n") : undefined;
  const ownerAllowFrom = resolveDiscordOwnerAllowFrom({
    channelConfig,
    guildInfo,
    sender: { id: sender.id, name: sender.name, tag: sender.tag },
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
    UntrustedContext: untrustedChannelMetadata ? [untrustedChannelMetadata] : undefined,
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
  });

  const { dispatcher, replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping({
    ...prefixOptions,
    humanDelay: resolveHumanDelayConfig(cfg, route.agentId),
    typingCallbacks,
    deliver: async (payload: ReplyPayload) => {
      if ((payload as { isReasoning?: boolean }).isReasoning) {
        return;
      }
      // In partial mode, finalize by editing the preview message if the final fits one chunk
      const maxLines = (discordConfig as Record<string, unknown> | undefined)?.maxLinesPerMessage as
        | number
        | undefined;
      const previewId = draftStream?.messageId();
      if (streamMode === "partial" && previewId && payload.text) {
        const lineCount = payload.text.split("\n").length;
        if (!maxLines || lineCount <= maxLines) {
          await editMessageDiscord(
            resolvedMessageChannelId,
            previewId,
            { content: payload.text },
            { rest: client.rest },
          );
          replyReference.markSent();
          return;
        }
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
        textLimit,
        maxLinesPerMessage: maxLines,
        tableMode,
        chunkMode: resolveChunkMode(cfg, "discord", accountId),
      });
      replyReference.markSent();
    },
    onError: (err, info) => {
      runtime.error?.(danger(`discord ${info.kind} reply failed: ${String(err)}`));
    },
    onReplyStart: async () => {
      await typingCallbacks.onReplyStart();
      await statusReactions.setThinking();
    },
  });

  // Resolve streaming mode (streamMode / streaming are extension fields)
  const dcAny = discordConfig as Record<string, unknown> | undefined;
  const streamMode: string =
    (dcAny?.streamMode as string) ?? (dcAny?.streaming === true ? "partial" : "off");

  const draftStream =
    streamMode === "block" || streamMode === "partial"
      ? createDiscordDraftStream({
          rest: client.rest as never,
          channelId: resolvedMessageChannelId,
        })
      : null;

  const draftChunkConfig = (cfg as Record<string, unknown>)?.channels as
    | Record<string, unknown>
    | undefined;
  const discordDraftChunk = (draftChunkConfig?.discord as Record<string, unknown> | undefined)
    ?.draftChunk as { minChars?: number; maxChars?: number } | undefined;

  let dispatchResult: Awaited<ReturnType<typeof dispatchInboundMessage>> | null = null;
  let dispatchError = false;
  try {
    dispatchResult = await dispatchInboundMessage({
      ctx: ctxPayload,
      cfg,
      dispatcher,
      replyOptions: {
        ...replyOptions,
        skillFilter: channelConfig?.skills,
        disableBlockStreaming:
          typeof discordConfig?.blockStreaming === "boolean"
            ? !discordConfig.blockStreaming
            : undefined,
        onModelSelected,
        onReasoningStream: async () => {
          await statusReactions.setThinking();
        },
        onToolStart: async (payload) => {
          await statusReactions.setTool(payload.name);
        },
        onPartialReply: draftStream
          ? async (payload: { text?: string }) => {
              let text = payload.text ?? "";
              // Strip reasoning tags
              text = text.replace(/<thinking>[\s\S]*?<\/thinking>\n?/g, "").trimStart();
              // Skip pure-reasoning partial updates
              if (!text || text.startsWith("Reasoning:")) {
                return;
              }
              const chunkMax = discordDraftChunk?.maxChars;
              if (chunkMax) {
                for (let i = chunkMax; i <= text.length; i += chunkMax) {
                  draftStream.update(text.slice(0, i));
                }
                if (text.length % chunkMax !== 0) {
                  draftStream.update(text);
                }
              } else {
                draftStream.update(text);
              }
            }
          : undefined,
        onAssistantMessageStart:
          draftStream && streamMode === "block"
            ? async () => {
                draftStream.forceNewMessage();
              }
            : undefined,
      },
    });
  } catch (err) {
    dispatchError = true;
    throw err;
  } finally {
    markDispatchIdle();
    if (statusReactionsEnabled) {
      if (dispatchError) {
        await statusReactions.setError();
      } else {
        await statusReactions.setDone();
      }
      if (removeAckAfterReply) {
        void (async () => {
          await sleep(dispatchError ? DISCORD_STATUS_ERROR_HOLD_MS : DISCORD_STATUS_DONE_HOLD_MS);
          await statusReactions.clear();
        })();
      } else {
        void statusReactions.restoreInitial();
      }
    }
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
