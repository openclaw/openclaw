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
import {
  removeAckReactionAfterReply,
  shouldAckReaction as shouldAckReactionGate,
} from "../../channels/ack-reactions.js";
import { logTypingFailure, logAckFailure } from "../../channels/logging.js";
import { createReplyPrefixOptions } from "../../channels/reply-prefix.js";
import { recordInboundSession } from "../../channels/session.js";
import { createTypingCallbacks } from "../../channels/typing.js";
import { resolveMarkdownTableMode } from "../../config/markdown-tables.js";
import { readSessionUpdatedAt, resolveStorePath } from "../../config/sessions.js";
import { danger, logVerbose, shouldLogVerbose } from "../../globals.js";
import { buildAgentSessionKey } from "../../routing/resolve-route.js";
import { resolveThreadSessionKeys } from "../../routing/session-key.js";
import { buildUntrustedChannelMetadata } from "../../security/channel-metadata.js";
import { truncateUtf16Safe } from "../../utils.js";
import { getActiveJobForUser, createJob, updateJob, appendJobEvent } from "../jobs/store.js";
import {
  deleteMessageDiscord,
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
import { startSmartAck, type SmartAckConfig, type SmartAckContext } from "./smart-ack.js";
import { createSmartStatus } from "./smart-status.js";
import { resolveDiscordAutoThreadReplyPlan, resolveDiscordThreadStarter } from "./threading.js";
import { sendTyping } from "./typing.js";

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

  // Start typing loop immediately if audio is detected (before transcription).
  // Discord clears typing after 10s, and transcription can take 10-30s, so we need a loop.
  // This same loop continues through the main reply flow via the onReplyStart callback.
  const hasAudio = mediaList.some((m) => m.contentType?.startsWith("audio/"));
  let earlyTypingInterval: ReturnType<typeof setInterval> | undefined;
  if (hasAudio) {
    // Start typing immediately (fire-and-forget to avoid blocking)
    void sendTyping({ rest: client.rest, channelId: message.channelId }).catch((err) => {
      logVerbose(`discord: early audio typing failed: ${String(err)}`);
    });
    // Start a loop that sends typing every 6 seconds (Discord clears after 10s)
    earlyTypingInterval = setInterval(() => {
      void sendTyping({ rest: client.rest, channelId: message.channelId }).catch((err) => {
        logVerbose(`discord: early audio typing loop failed: ${String(err)}`);
      });
    }, 6000);
  }

  const text = messageText;
  if (!text) {
    if (earlyTypingInterval) {
      clearInterval(earlyTypingInterval);
    }
    logVerbose(`discord: drop message ${message.id} (empty content)`);
    return;
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
    if (earlyTypingInterval) {
      clearInterval(earlyTypingInterval);
    }
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

  const { dispatcher, replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping({
    ...prefixOptions,
    humanDelay: resolveHumanDelayConfig(cfg, route.agentId),
    deliver: async (payload: ReplyPayload) => {
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
        maxLinesPerMessage: discordConfig?.maxLinesPerMessage,
        tableMode,
        chunkMode: resolveChunkMode(cfg, "discord", accountId),
      });
      replyReference.markSent();
    },
    onError: (err, info) => {
      runtime.error?.(danger(`discord ${info.kind} reply failed: ${String(err)}`));
    },
    onReplyStart: createTypingCallbacks({
      start: () => {
        // Clear the early typing interval when main typing loop takes over.
        if (earlyTypingInterval) {
          clearInterval(earlyTypingInterval);
          earlyTypingInterval = undefined;
        }
        return sendTyping({ rest: client.rest, channelId: typingChannelId });
      },
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
    const ackText = typeof quickAck === "string" ? quickAck : "*Processing your request...*";
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
      chunkMode: resolveChunkMode(cfg, "discord", accountId),
    }).catch((err) => {
      logVerbose(`discord: quick ack failed: ${String(err)}`);
    });
  }

  // Unified status message: a single Discord message that gets edited in-place for all
  // interim feedback (tool status, progress timer, smart ack). Prevents message spam.
  let statusMessageId: string | undefined;
  let statusChannelId: string | undefined;
  let statusLastText: string | undefined;
  let statusSending = false;

  const updateStatusMessage = async (text: string) => {
    if (statusSending) {
      return;
    }
    if (text === statusLastText) {
      return;
    }
    statusLastText = text;
    statusSending = true;
    try {
      if (statusMessageId && statusChannelId) {
        await editMessageDiscord(
          statusChannelId,
          statusMessageId,
          { content: text },
          { rest: client.rest },
        );
      } else {
        const result = await sendMessageDiscord(deliverTarget, text, {
          token,
          accountId,
          rest: client.rest,
        });
        statusMessageId = result.messageId !== "unknown" ? result.messageId : undefined;
        statusChannelId = result.channelId;
      }
      // Reinforce typing after status message updates. Sending a new message
      // clears Discord's typing indicator, and edits can cause brief drops.
      // Fire-and-forget to avoid blocking the status update flow.
      void sendTyping({ rest: client.rest, channelId: typingChannelId }).catch(() => {});
    } catch (err) {
      logVerbose(`discord: status message update failed: ${String(err)}`);
    } finally {
      statusSending = false;
    }
  };

  const deleteStatusMessage = () => {
    if (statusMessageId && statusChannelId) {
      deleteMessageDiscord(statusChannelId, statusMessageId, { rest: client.rest }).catch((err) => {
        logVerbose(`discord: failed to delete status message: ${String(err)}`);
      });
      statusMessageId = undefined;
      statusChannelId = undefined;
    }
  };

  // Smart status: accumulate streaming context and periodically generate
  // context-aware Haiku status updates. Replaces tool-feedback-filter + progress timer.
  const toolFeedbackEnabled = discordConfig?.toolFeedback !== false;
  const smartStatusFilter = toolFeedbackEnabled
    ? createSmartStatus({
        userMessage: text,
        onUpdate: (statusText) => {
          void updateStatusMessage(statusText);
        },
      })
    : null;

  // Sonnet triage: classify as simple (FULL) or complex (ACK).
  // For simple messages, Sonnet's response is delivered directly and Opus is skipped.
  // For complex messages, an immediate status update is shown while Opus works.
  const smartAckConfig = discordConfig?.smartAck;
  const smartAckEnabled =
    smartAckConfig === true ||
    (typeof smartAckConfig === "object" && smartAckConfig?.enabled !== false);

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
  if (smartAckController) {
    const triageResult = await smartAckController.result;
    if (triageResult?.isFull) {
      // Short-circuit: Sonnet answered fully. Deliver and clean up.
      logVerbose(`smart-ack: short-circuit with full response (${triageResult.text.length} chars)`);

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
        chunkMode: resolveChunkMode(cfg, "discord", accountId),
      });

      // Clean up all resources.
      if (earlyTypingInterval) {
        clearInterval(earlyTypingInterval);
        earlyTypingInterval = undefined;
      }
      if (smartStatusFilter) {
        smartStatusFilter.dispose();
      }
      deleteStatusMessage();
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

      return; // Skip Opus dispatch entirely.
    }

    // Complex path: show the ack as a status message immediately while Opus works.
    if (triageResult?.text) {
      smartStatusFilter?.suppress(10000);
      void updateStatusMessage(triageResult.text);
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
      // Disable tool feedback as separate block replies; smart-status handles updates.
      toolFeedback: false,
      // Forward streaming events to smart-status for context-aware periodic updates.
      onStreamEvent: smartStatusFilter
        ? (event: import("../../auto-reply/types.js").AgentStreamEvent) => {
            smartStatusFilter.push(event);
          }
        : undefined,
      onModelSelected,
    },
  });
  markDispatchIdle();
  // Clean up early typing interval if it wasn't cleared by main typing loop.
  if (earlyTypingInterval) {
    clearInterval(earlyTypingInterval);
    earlyTypingInterval = undefined;
  }
  // Clean up smart-status filter and delete the status message.
  if (smartStatusFilter) {
    smartStatusFilter.dispose();
  }
  deleteStatusMessage();
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
