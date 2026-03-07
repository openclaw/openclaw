import { ChannelType } from "@buape/carbon";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { DiscordMessagePreflightContext } from "./message-handler.preflight.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { loadAgentIdentityFromWorkspace } from "../../agents/identity-file.js";
import {
  resolveAckReaction,
  resolveAgentIdentity,
  resolveHumanDelayConfig,
} from "../../agents/identity.js";
import { formatToolResultBlockDiscord, resolveToolDisplay } from "../../agents/tool-display.js";
import { resolveChunkMode } from "../../auto-reply/chunk.js";
import { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import {
  formatInboundEnvelope,
  formatThreadStarterEnvelope,
  resolveEnvelopeFormatOptions,
} from "../../auto-reply/envelope.js";
import {
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
} from "../../auto-reply/reply/history.js";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import { createReplyDispatcherWithTyping } from "../../auto-reply/reply/reply-dispatcher.js";
import { createSmartStatus } from "../../auto-reply/smart-status.js";
import { createUnifiedToolFeedback } from "../../auto-reply/tool-feedback-filter.js";
import {
  removeAckReactionAfterReply,
  shouldAckReaction as shouldAckReactionGate,
} from "../../channels/ack-reactions.js";
import { logTypingFailure, logAckFailure } from "../../channels/logging.js";
import { createReplyPrefixOptions } from "../../channels/reply-prefix.js";
import { recordInboundSession } from "../../channels/session.js";
import { createTypingCallbacks } from "../../channels/typing.js";
import { resolveMarkdownTableMode, resolveTableHairspacing } from "../../config/markdown-tables.js";
import { loadSessionStore, readSessionUpdatedAt, resolveStorePath } from "../../config/sessions.js";
import { danger, logVerbose, shouldLogVerbose } from "../../globals.js";
import { emitAgentEvent, registerAgentRunContext } from "../../infra/agent-events.js";
import { buildAgentSessionKey } from "../../routing/resolve-route.js";
import { resolveThreadSessionKeys } from "../../routing/session-key.js";
import { buildUntrustedChannelMetadata } from "../../security/channel-metadata.js";
import { truncateUtf16Safe } from "../../utils.js";
import { getActiveJobForUser, createJob, updateJob, appendJobEvent } from "../jobs/store.js";
import {
  editMessageDiscord,
  reactMessageDiscord,
  removeReactionDiscord,
  sendMessageDiscord,
} from "../send.js";
import { normalizeDiscordSlug, resolveDiscordOwnerAllowFrom } from "./allow-list.js";
import { resolveTimestampMs } from "./format.js";
import { startJobClassification, type JobClassificationController } from "./job-classifier.js";
import {
  buildDiscordMediaPayload,
  resolveDiscordMessageText,
  resolveMediaList,
} from "./message-utils.js";
import { buildDirectLabel, buildGuildLabel, resolveReplyContext } from "./reply-context.js";
import { deliverDiscordReply } from "./reply-delivery.js";
import {
  startSmartAck,
  type SmartAckConfig,
  type SmartAckContext,
  type SmartAckResult,
} from "./smart-ack.js";
import { resolveDiscordAutoThreadReplyPlan, resolveDiscordThreadStarter } from "./threading.js";
import { createTypingGuard } from "./typing-guard.js";
import { sendTyping } from "./typing.js";

const DEFAULT_ACK_DELAY_MS = 5000;

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
  } = ctx;

  const mediaList = await resolveMediaList(message, mediaMaxBytes);

  // Ref-counted typing guard: keeps the indicator alive while any job is running.
  const hasAudio = mediaList.some((m) => m.contentType?.startsWith("audio/"));
  const typingGuard = createTypingGuard({
    rest: client.rest,
    channelId: message.channelId,
    onError: (err) => logVerbose(`discord: typing failed: ${String(err)}`),
    onFire: () => logVerbose(`discord: typing fire channel=${message.channelId}`),
    onDispose: () => logVerbose(`discord: typing disposed channel=${message.channelId}`),
  });

  // Start typing immediately for audio (transcription can take 10-30s).
  if (hasAudio) {
    typingGuard.acquire();
  }

  const text = messageText;
  if (!text) {
    typingGuard.dispose();
    logVerbose(`discord: drop message ${message.id} (empty content)`);
    return;
  }

  // Start typing for all messages so the user sees feedback within seconds.
  if (!hasAudio) {
    typingGuard.acquire();
  }

  // Start job classification in parallel for DMs (uses Haiku for fast topic routing).
  // Runs before smart-ack and dispatch so the result is available when needed.
  const jobsConfig = discordConfig?.jobs;
  const jobsEnabled =
    isDirectMessage &&
    (jobsConfig === true || (typeof jobsConfig === "object" && jobsConfig?.enabled !== false));
  let jobClassificationController: JobClassificationController | null = null;
  if (jobsEnabled) {
    const classifierConfig = typeof jobsConfig === "object" ? jobsConfig?.classifier : undefined;
    const activeJob = await getActiveJobForUser(route.agentId, author.id).catch(() => null);
    jobClassificationController = startJobClassification({
      message: text,
      senderName: sender.name,
      previousJobSummary: activeJob?.summary,
      cfg,
      config: classifierConfig,
    });
  }

  const ackReaction = resolveAckReaction(cfg, route.agentId);
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
  const ackReactionPromise = shouldAckReaction()
    ? reactMessageDiscord(message.channelId, message.id, ackReaction, {
        rest: client.rest,
      }).then(
        () => true,
        (err) => {
          logVerbose(`discord react failed for channel ${message.channelId}: ${String(err)}`);
          return false;
        },
      )
    : null;

  const fromLabel = isDirectMessage
    ? buildDirectLabel(author)
    : buildGuildLabel({
        guild: data.guild ?? undefined,
        channelName: channelName ?? message.channelId,
        channelId: message.channelId,
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
      historyKey: message.channelId,
      limit: historyLimit,
      currentMessage: combinedBody,
      formatEntry: (entry) =>
        formatInboundEnvelope({
          channel: "Discord",
          from: fromLabel,
          timestamp: entry.timestamp,
          body: `${entry.body} [id:${entry.messageId ?? "unknown"} channel:${message.channelId}]`,
          chatType: "channel",
          senderLabel: entry.sender,
          envelope: envelopeOptions,
        }),
    });
  }
  const replyContext = resolveReplyContext(message, resolveDiscordMessageText, {
    envelope: envelopeOptions,
  });
  if (replyContext) {
    combinedBody = `[Replied message - for context]\n${replyContext}\n\n${combinedBody}`;
  }
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
        const starterEnvelope = formatThreadStarterEnvelope({
          channel: "Discord",
          author: starter.author,
          timestamp: starter.timestamp,
          body: starter.text,
          envelope: envelopeOptions,
        });
        threadStarterBody = starterEnvelope;
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
    threadId: threadChannel ? message.channelId : undefined,
    parentSessionKey,
    useSuffix: false,
  });
  const replyPlan = await resolveDiscordAutoThreadReplyPlan({
    client,
    message,
    isGuildMessage,
    channelConfig,
    threadChannel,
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
    : (autoThreadContext?.From ?? `discord:channel:${message.channelId}`);
  const effectiveTo = autoThreadContext?.To ?? replyTarget;
  if (!effectiveTo) {
    typingGuard.dispose();
    runtime.error?.(danger("discord: missing reply target"));
    return;
  }

  const ctxPayload = finalizeInboundContext({
    Body: combinedBody,
    RawBody: baseText,
    CommandBody: baseText,
    From: effectiveFrom,
    To: effectiveTo,
    SessionKey: autoThreadContext?.SessionKey ?? threadKeys.sessionKey,
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

  await recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    updateLastRoute: isDirectMessage
      ? {
          sessionKey: route.mainSessionKey,
          channel: "discord",
          to: `user:${author.id}`,
          accountId: route.accountId,
        }
      : undefined,
    onRecordError: (err) => {
      logVerbose(`discord: failed updating session meta: ${String(err)}`);
    },
  });

  if (shouldLogVerbose()) {
    const preview = truncateUtf16Safe(combinedBody, 200).replace(/\n/g, "\\n");
    logVerbose(
      `discord inbound: channel=${message.channelId} deliver=${deliverTarget} from=${ctxPayload.From} preview="${preview}"`,
    );
  }

  const typingChannelId = deliverTarget.startsWith("channel:")
    ? deliverTarget.slice("channel:".length)
    : message.channelId;

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
  const tableHairspacing = resolveTableHairspacing({
    cfg,
    channel: "discord",
    accountId,
  });

  // Track unclosed inline markers across block deliveries so bold
  // spans split by streaming boundaries render correctly. Each call
  // to deliverDiscordReply returns the markers that were left open;
  // the next delivery strips the matching orphaned closers.
  let pendingMarkers: string[] = [];

  const { dispatcher, replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping({
    ...prefixOptions,
    humanDelay: resolveHumanDelayConfig(cfg, route.agentId),
    deliver: async (payload: ReplyPayload, info) => {
      // Dispose the typing guard before final delivery so no stale
      // typing signals arrive at Discord after the message (which
      // would briefly re-show "typing").
      if (info.kind === "final") {
        typingGuard.dispose();
      }
      const replyToId = replyReference.use();
      pendingMarkers = await deliverDiscordReply({
        replies: [payload],
        target: deliverTarget,
        token,
        accountId,
        rest: client.rest,
        runtime,
        replyToId,
        textLimit,
        maxLinesPerMessage: discordConfig?.maxLinesPerMessage,
        tableMode,
        tableHairspacing,
        chunkMode: resolveChunkMode(cfg, "discord", accountId),
        discordTimestamps: discordConfig?.discordTimestamps,
        pendingMarkers,
      });
      replyReference.markSent();
    },
    onError: (err, info) => {
      runtime.error?.(danger(`discord ${info.kind} reply failed: ${String(err)}`));
    },
    onReplyStart: createTypingCallbacks({
      start: () => sendTyping({ rest: client.rest, channelId: typingChannelId }),
      onStartError: (err) => {
        logTypingFailure({
          log: logVerbose,
          channel: "discord",
          target: typingChannelId,
          error: err,
        });
      },
    }).onReplyStart,
  });

  // Send quick acknowledgment if configured (before processing starts).
  // This gives immediate feedback while the model is thinking.
  const quickAck = discordConfig?.quickAck;
  if (quickAck) {
    const ackText = typeof quickAck === "string" ? quickAck : "Processing your request...";
    await deliverDiscordReply({
      replies: [{ text: ackText }],
      target: deliverTarget,
      token,
      accountId,
      rest: client.rest,
      runtime,
      textLimit,
      maxLinesPerMessage: discordConfig?.maxLinesPerMessage,
      tableMode,
      tableHairspacing,
      chunkMode: resolveChunkMode(cfg, "discord", accountId),
    }).catch((err) => {
      logVerbose(`discord: quick ack failed: ${String(err)}`);
    });
  }

  // Status messages: periodic tool feedback and thinking updates sent
  // throughout a long task. Rate-limited with a cooldown to avoid
  // flooding the channel. Tool result blocks edit the original status
  // message in-place so each tool's lifecycle stays in one message.
  // When editing would exceed Discord's 2000-char limit, results fall
  // back to a new message. Non-tool status updates (smart-status
  // thinking excerpts) still send as new messages.
  const STATUS_COOLDOWN_MS = 10_000;
  const DISCORD_MAX_CONTENT = 2000;
  let lastStatusSendTime = 0;
  let sendingStatus = false;
  const pendingResultBlocks: string[] = [];
  // Track block flush operations so tool feedback can wait for them.
  let blockFlushPromise: Promise<void> | null = null;

  const doSendStatus = async (text: string) => {
    const result = await sendMessageDiscord(deliverTarget, text, {
      token,
      accountId,
      rest: client.rest,
    });
    lastStatusSendTime = Date.now();
    typingGuard.reinforce();
    return result;
  };

  // Track status messages so tool results can edit them in-place.
  // Multiple tool calls in the same batch share one ref.
  type StatusMessageRef = {
    sendPromise: Promise<{ messageId: string; channelId: string } | null>;
    content: string;
    editChain: Promise<void>;
  };
  const toolCallStatusRefs = new Map<string, StatusMessageRef>();

  // Edit a tracked status message to append a tool result block.
  // Returns true if the edit succeeded, false if the caller should
  // fall back to sending a new message.
  const editStatusWithResult = async (
    toolCallId: string,
    resultBlock: string,
  ): Promise<boolean> => {
    const ref = toolCallStatusRefs.get(toolCallId);
    if (!ref) return false;

    const msg = await ref.sendPromise;
    if (!msg) {
      toolCallStatusRefs.delete(toolCallId);
      return false;
    }

    // Replace the status line entirely with the result block,
    // which already has its own header (e.g. *Bash* (...)).
    const newContent = resultBlock;
    if (newContent.length > DISCORD_MAX_CONTENT) {
      toolCallStatusRefs.delete(toolCallId);
      return false;
    }

    // Update content before chaining so subsequent edits see the
    // latest state when computing their newContent.
    ref.content = newContent;

    // Chain the edit onto previous edits for the same message
    // to avoid race conditions from concurrent tool results.
    // Capture newContent in the closure so each edit sends the
    // content that was current when it was queued.
    const captured = newContent;
    ref.editChain = ref.editChain.then(async () => {
      try {
        await editMessageDiscord(
          msg.channelId,
          msg.messageId,
          {
            content: captured,
          },
          { rest: client.rest },
        );
      } catch (err) {
        logVerbose(`discord: status message edit failed: ${String(err)}`);
      }
    });
    toolCallStatusRefs.delete(toolCallId);
    return true;
  };

  const flushPendingResults = async () => {
    while (pendingResultBlocks.length > 0) {
      const next = pendingResultBlocks.shift()!;
      try {
        await doSendStatus(next);
      } catch (err) {
        logVerbose(`discord: queued result block send failed: ${String(err)}`);
      }
    }
  };

  const sendStatusMessage = async (text: string, opts?: { bypassCooldown?: boolean }) => {
    // Tool result blocks: queue if a send is in flight instead
    // of dropping, since they contain substantive content.
    if (opts?.bypassCooldown && sendingStatus) {
      pendingResultBlocks.push(text);
      return;
    }
    if (sendingStatus) {
      return;
    }
    if (!opts?.bypassCooldown) {
      // Cooldown: avoid flooding the channel with rapid status
      // updates. Upstream filters (unifiedToolFeedback 15s,
      // smartStatus 3s) already rate-limit, but this is a
      // safety net.
      const elapsed = Date.now() - lastStatusSendTime;
      if (lastStatusSendTime > 0 && elapsed < STATUS_COOLDOWN_MS) {
        return;
      }
    }
    // Wait for any in-progress block flush to complete first.
    // This ensures acknowledgment text is sent before tool feedback.
    if (blockFlushPromise) {
      await blockFlushPromise;
    }
    // Also wait for dispatcher queue to be idle.
    await dispatcher.waitForIdle();
    sendingStatus = true;
    try {
      await doSendStatus(text);
    } catch (err) {
      logVerbose(`discord: status message send failed: ${String(err)}`);
    } finally {
      // Flush any queued result blocks before releasing the lock.
      await flushPendingResults();
      sendingStatus = false;
    }
  };

  // Unified tool feedback: buffers tool calls, groups similar commands,
  // rate-limits output, and formats using code blocks.
  // Check session-level toolFeedback override (set by /toolfeedback command).
  const sessionToolFeedback = (() => {
    try {
      const sessionKey = route.sessionKey;
      if (storePath && sessionKey) {
        const store = loadSessionStore(storePath);
        return store[sessionKey]?.toolFeedback;
      }
    } catch {
      // Ignore errors reading session store.
    }
    return undefined;
  })();
  const toolFeedbackEnabled =
    sessionToolFeedback !== undefined ? sessionToolFeedback : discordConfig?.toolFeedback !== false;
  const unifiedToolFeedback = toolFeedbackEnabled
    ? createUnifiedToolFeedback({
        onUpdate: (feedbackText, toolCallIds) => {
          const sendPromise = (async () => {
            try {
              // Wait for any in-progress block flush first.
              if (blockFlushPromise) await blockFlushPromise;
              await dispatcher.waitForIdle();
              return await doSendStatus(feedbackText);
            } catch (err) {
              logVerbose(`discord: tool feedback send failed: ${String(err)}`);
              return null;
            }
          })();

          // Associate each tool call ID with this status message
          // so results can edit it in-place.
          if (toolCallIds?.length) {
            const ref: StatusMessageRef = {
              sendPromise,
              content: feedbackText,
              editChain: Promise.resolve(),
            };
            for (const id of toolCallIds) {
              toolCallStatusRefs.set(id, ref);
            }
          }
        },
      })
    : null;

  // Smart status: deterministic stream-based status updates for
  // long-running tasks. Uses tool-display formatting and thinking excerpts
  // as a fallback alongside the per-batch unified tool feedback.
  const smartStatusFilter = toolFeedbackEnabled
    ? createSmartStatus({
        userMessage: text,
        onUpdate: (statusText) => {
          void sendStatusMessage(statusText);
        },
      })
    : null;

  // Track tool start inputs so we can correlate them with results for
  // rich formatting (tool name + args + output preview).
  const toolStartInputs = toolFeedbackEnabled ? new Map<string, Record<string, unknown>>() : null;

  // Sonnet triage: classify as simple (FULL) or complex (ACK).
  // For simple messages, Sonnet's response is delivered directly and Opus is skipped.
  // For complex messages, an immediate status update is shown while Opus works.
  const smartAckConfig = discordConfig?.smartAck;
  const smartAckEnabled =
    smartAckConfig === true ||
    (typeof smartAckConfig === "object" && smartAckConfig?.enabled === true);

  // Build rich context for the triage model.
  let triageContext: SmartAckContext | undefined;
  if (smartAckEnabled) {
    const configIdentity = resolveAgentIdentity(cfg, route.agentId);
    const workspaceDir = resolveAgentWorkspaceDir(cfg, route.agentId);
    const fileIdentity = loadAgentIdentityFromWorkspace(workspaceDir);
    triageContext = {
      agentName: configIdentity?.name ?? fileIdentity?.name,
      agentVibe: fileIdentity?.vibe,
      agentCreature: fileIdentity?.creature,
      conversationContext: combinedBody,
      channelSystemPrompt: isGuildMessage ? groupSystemPrompt : undefined,
      isDirectMessage,
    };
  }

  const smartAckController = smartAckEnabled
    ? startSmartAck({
        message: text,
        senderName: sender.name,
        cfg,
        config: typeof smartAckConfig === "object" ? (smartAckConfig as SmartAckConfig) : undefined,
        context: triageContext,
      })
    : null;

  // Await triage result. If FULL, deliver directly and skip Opus dispatch.
  let triageResult: SmartAckResult | null | undefined;
  if (smartAckController) {
    triageResult = await smartAckController.result;
    if (triageResult?.isFull) {
      // Short-circuit: Sonnet answered fully. Deliver and clean up.
      logVerbose(`smart-ack: short-circuit with full response (${triageResult.text.length} chars)`);

      // Emit agent events so the Jobs dashboard tracks this run.
      const smartAckRunId = crypto.randomUUID();
      const smartAckStartedAt = Date.now();
      const smartAckSessionKey = ctxPayload.SessionKey ?? route.sessionKey;
      registerAgentRunContext(smartAckRunId, {
        sessionKey: smartAckSessionKey,
        channel: "discord",
      });
      emitAgentEvent({
        runId: smartAckRunId,
        stream: "lifecycle",
        data: { phase: "start", startedAt: smartAckStartedAt },
      });

      // Dispose the typing guard before delivery so no stale typing signals
      // can arrive at Discord after the message (which would re-show "typing").
      typingGuard.dispose();

      const replyToId = replyReference.use();
      await deliverDiscordReply({
        replies: [{ text: triageResult.text }],
        target: deliverTarget,
        token,
        accountId,
        rest: client.rest,
        runtime,
        replyToId,
        textLimit,
        maxLinesPerMessage: discordConfig?.maxLinesPerMessage,
        tableMode,
        tableHairspacing,
        chunkMode: resolveChunkMode(cfg, "discord", accountId),
        discordTimestamps: discordConfig?.discordTimestamps,
      });

      // Clean up remaining resources.
      if (unifiedToolFeedback) {
        unifiedToolFeedback.dispose();
      }
      if (smartStatusFilter) {
        smartStatusFilter.dispose();
      }

      markDispatchIdle();

      // Cancel job classification if still running.
      if (jobClassificationController) {
        jobClassificationController.cancel();
      }

      // Remove ack reaction after reply.
      removeAckReactionAfterReply({
        removeAfterReply: removeAckAfterReply,
        ackReactionPromise,
        ackReactionValue: ackReaction,
        remove: async () => {
          await removeReactionDiscord(message.channelId, message.id, ackReaction, {
            rest: client.rest,
          });
        },
        onError: (err) => {
          logAckFailure({
            log: logVerbose,
            channel: "discord",
            target: `${message.channelId}/${message.id}`,
            error: err,
          });
        },
      });

      if (isGuildMessage) {
        clearHistoryEntriesIfEnabled({
          historyMap: guildHistories,
          historyKey: message.channelId,
          limit: historyLimit,
        });
      }

      // Close agent events so the Jobs dashboard marks this run as completed.
      emitAgentEvent({
        runId: smartAckRunId,
        stream: "assistant",
        data: { text: triageResult.text },
      });
      emitAgentEvent({
        runId: smartAckRunId,
        stream: "lifecycle",
        data: { phase: "end", startedAt: smartAckStartedAt, endedAt: Date.now() },
      });

      return; // Skip Opus dispatch entirely.
    }
  }

  // Await job classification and create/update job entry.
  let currentJobId: string | undefined;
  if (jobClassificationController) {
    const classification = await jobClassificationController.result;
    const activeJob = await getActiveJobForUser(route.agentId, author.id).catch(() => null);
    if (classification.decision === "NEW" || !activeJob) {
      const job = await createJob({
        agentId: route.agentId,
        userId: author.id,
        sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
        prompt: text,
      }).catch((err) => {
        logVerbose(`discord: failed to create job: ${String(err)}`);
        return null;
      });
      currentJobId = job?.jobId;
    } else {
      currentJobId = activeJob.jobId;
      await appendJobEvent(route.agentId, activeJob.jobId, {
        ts: Date.now(),
        jobId: activeJob.jobId,
        event: "message",
        data: { prompt: text },
      }).catch((err) => {
        logVerbose(`discord: failed to append job event: ${String(err)}`);
      });
    }
  }

  // ACK case: set up delayed sending for interim feedback if the main model takes too long.
  const ackDelayMs = DEFAULT_ACK_DELAY_MS;
  let _smartAckMessageId: string | undefined;
  let _smartAckChannelId: string | undefined;
  let smartAckCancelled = false;
  let _smartAckDelayTimer: ReturnType<typeof setTimeout> | undefined;
  if (triageResult && !triageResult.isFull) {
    const ackText = triageResult.text;
    _smartAckDelayTimer = setTimeout(async () => {
      if (smartAckCancelled) {
        return;
      }
      try {
        // Suppress updates briefly so the ack isn't immediately overwritten.
        unifiedToolFeedback?.suppress(10000);
        smartStatusFilter?.suppress(10000);

        const result = await sendMessageDiscord(deliverTarget, ackText, {
          token,
          accountId,
          rest: client.rest,
        });
        if (!smartAckCancelled) {
          _smartAckMessageId = result.messageId !== "unknown" ? result.messageId : undefined;
          _smartAckChannelId = result.channelId;
        }
      } catch (err) {
        logVerbose(`discord: smart ack delivery failed: ${String(err)}`);
      }
    }, ackDelayMs);
  }

  const { queuedFinal, counts } = await dispatchInboundMessage({
    ctx: ctxPayload,
    cfg,
    dispatcher,
    replyOptions: {
      ...replyOptions,
      skillFilter: channelConfig?.skills,
      // Enable block streaming by default for Discord. Responses are sent incrementally
      // (paragraph-by-paragraph) instead of waiting for the full response.
      disableBlockStreaming:
        typeof discordConfig?.blockStreaming === "boolean" ? !discordConfig.blockStreaming : false,
      // Feed tool calls to the unified filter for grouped, code-formatted
      // Discord feedback. Providing onToolStatus bypasses the default
      // italic block-reply formatting in dispatch-from-config.ts.
      toolFeedback: toolFeedbackEnabled,
      // Track block flush operations so tool feedback can wait for them to complete.
      // This ensures acknowledgment text appears before tool digests.
      onBlockReplyFlush: () => {
        const flushPromise = dispatcher.waitForIdle();
        blockFlushPromise = flushPromise;
        void flushPromise.finally(() => {
          if (blockFlushPromise === flushPromise) {
            blockFlushPromise = null;
          }
        });
      },
      onToolStatus: unifiedToolFeedback
        ? (info: { toolName: string; toolCallId: string; input?: Record<string, unknown> }) => {
            // Store input for later correlation with tool results.
            toolStartInputs?.set(info.toolCallId, info.input ?? {});
            unifiedToolFeedback.push(info);
          }
        : undefined,
      // Forward streaming events to smart-status for periodic updates
      // and send rich tool result blocks when output is available.
      onStreamEvent: toolFeedbackEnabled
        ? (event: import("../../auto-reply/types.js").AgentStreamEvent) => {
            smartStatusFilter?.push(event);
            // When a tool finishes with output, send a rich result block.
            // Remove any buffered tool-start message for this call first
            // so the user doesn't see both "Reading..." and the result.
            if (event.type === "tool_result" && event.outputPreview && toolStartInputs) {
              unifiedToolFeedback?.removeToolCall(event.toolCallId);
              const display = resolveToolDisplay({
                name: event.toolName,
                args: toolStartInputs.get(event.toolCallId),
              });
              const block = formatToolResultBlockDiscord(
                display,
                {
                  outputPreview: event.outputPreview,
                  lineCount: event.lineCount,
                  isError: event.isError,
                },
                toolStartInputs.get(event.toolCallId),
                { codeLangHints: discordConfig?.codeLangHints },
              );
              // Try to edit the original status message in-place
              // so the tool's lifecycle stays in one message.
              // Falls back to a new message if the edit would
              // exceed Discord's character limit or no status
              // message was sent for this tool call.
              const tryEdit = async () => {
                const edited = await editStatusWithResult(event.toolCallId, block);
                if (!edited) {
                  await sendStatusMessage(block, {
                    bypassCooldown: true,
                  });
                }
              };
              void tryEdit();
              // Clean up tracked input.
              toolStartInputs.delete(event.toolCallId);
            }
          }
        : undefined,
      onModelSelected,
    },
  });
  markDispatchIdle();
  typingGuard.dispose();
  // Clean up tool feedback and smart-status filters.
  if (unifiedToolFeedback) {
    unifiedToolFeedback.dispose();
  }
  if (smartStatusFilter) {
    smartStatusFilter.dispose();
  }
  // Mark job as completed after dispatch finishes.
  if (currentJobId) {
    await updateJob({
      agentId: route.agentId,
      jobId: currentJobId,
      status: "completed",
    }).catch((err) => {
      logVerbose(`discord: failed to complete job: ${String(err)}`);
    });
  }
  if (!queuedFinal) {
    if (isGuildMessage) {
      clearHistoryEntriesIfEnabled({
        historyMap: guildHistories,
        historyKey: message.channelId,
        limit: historyLimit,
      });
    }
    return;
  }
  if (shouldLogVerbose()) {
    const finalCount = counts.final;
    logVerbose(
      `discord: delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${replyTarget}`,
    );
  }
  removeAckReactionAfterReply({
    removeAfterReply: removeAckAfterReply,
    ackReactionPromise,
    ackReactionValue: ackReaction,
    remove: async () => {
      await removeReactionDiscord(message.channelId, message.id, ackReaction, {
        rest: client.rest,
      });
    },
    onError: (err) => {
      logAckFailure({
        log: logVerbose,
        channel: "discord",
        target: `${message.channelId}/${message.id}`,
        error: err,
      });
    },
  });
  if (isGuildMessage) {
    clearHistoryEntriesIfEnabled({
      historyMap: guildHistories,
      historyKey: message.channelId,
      limit: historyLimit,
    });
  }
}
