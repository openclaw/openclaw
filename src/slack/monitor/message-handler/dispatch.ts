import { resolveHumanDelayConfig } from "../../../agents/identity.js";
import { dispatchInboundMessage } from "../../../auto-reply/dispatch.js";
import { clearHistoryEntriesIfEnabled } from "../../../auto-reply/reply/history.js";
import { createReplyDispatcherWithTyping } from "../../../auto-reply/reply/reply-dispatcher.js";
import type { ReplyPayload } from "../../../auto-reply/types.js";
import { removeAckReactionAfterReply } from "../../../channels/ack-reactions.js";
import { logAckFailure, logTypingFailure } from "../../../channels/logging.js";
import { createReplyPrefixOptions } from "../../../channels/reply-prefix.js";
import { createTypingCallbacks } from "../../../channels/typing.js";
import { resolveStorePath, updateLastRoute } from "../../../config/sessions.js";
import { danger, logVerbose, shouldLogVerbose } from "../../../globals.js";
import { emitMessageSentHooks } from "../../../hooks/message-sent.js";
import { resolveAgentOutboundIdentity } from "../../../infra/outbound/identity.js";
import { removeSlackReaction } from "../../actions.js";
import { createSlackDraftStream } from "../../draft-stream.js";
import { recordSlackThreadParticipation } from "../../sent-thread-cache.js";
import {
  applyAppendOnlyStreamUpdate,
  buildStatusFinalPreviewText,
  resolveSlackStreamingConfig,
} from "../../stream-mode.js";
import type { SlackStreamSession } from "../../streaming.js";
import { appendSlackStream, startSlackStream, stopSlackStream } from "../../streaming.js";
import { resolveSlackThreadTargets } from "../../threading.js";
import { createSlackReplyDeliveryPlan, deliverReplies, resolveSlackThreadTs } from "../replies.js";
import type { PreparedSlackMessage } from "./types.js";

function hasMedia(payload: ReplyPayload): boolean {
  return Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
}

export function isSlackStreamingEnabled(params: {
  mode: "off" | "partial" | "block" | "progress";
  nativeStreaming: boolean;
}): boolean {
  if (params.mode !== "partial") {
    return false;
  }
  return params.nativeStreaming;
}

export function resolveSlackStreamingThreadHint(params: {
  replyToMode: "off" | "first" | "all";
  incomingThreadTs: string | undefined;
  messageTs: string | undefined;
  isThreadReply?: boolean;
}): string | undefined {
  return resolveSlackThreadTs({
    replyToMode: params.replyToMode,
    incomingThreadTs: params.incomingThreadTs,
    messageTs: params.messageTs,
    hasReplied: false,
    isThreadReply: params.isThreadReply,
  });
}

function shouldUseStreaming(params: {
  streamingEnabled: boolean;
  threadTs: string | undefined;
}): boolean {
  if (!params.streamingEnabled) {
    return false;
  }
  if (!params.threadTs) {
    logVerbose("slack-stream: streaming disabled — no reply thread target available");
    return false;
  }
  return true;
}

export async function dispatchPreparedSlackMessage(prepared: PreparedSlackMessage) {
  const { ctx, account, message, route } = prepared;
  const cfg = ctx.cfg;
  const runtime = ctx.runtime;

  // Resolve agent identity for Slack chat:write.customize overrides.
  const outboundIdentity = resolveAgentOutboundIdentity(cfg, route.agentId);
  const slackIdentity = outboundIdentity
    ? {
        username: outboundIdentity.name,
        iconUrl: outboundIdentity.avatarUrl,
        iconEmoji: outboundIdentity.emoji,
      }
    : undefined;

  if (prepared.isDirectMessage) {
    const sessionCfg = cfg.session;
    const storePath = resolveStorePath(sessionCfg?.store, {
      agentId: route.agentId,
    });
    await updateLastRoute({
      storePath,
      sessionKey: route.mainSessionKey,
      deliveryContext: {
        channel: "slack",
        to: `user:${message.user}`,
        accountId: route.accountId,
        threadId: prepared.ctxPayload.MessageThreadId,
      },
      ctx: prepared.ctxPayload,
    });
  }

  const { statusThreadTs, isThreadReply } = resolveSlackThreadTargets({
    message,
    replyToMode: prepared.replyToMode,
  });

  const messageTs = message.ts ?? message.event_ts;
  const incomingThreadTs = message.thread_ts;
  let didSetStatus = false;

  // Shared mutable ref for "replyToMode=first". Both tool + auto-reply flows
  // mark this to ensure only the first reply is threaded.
  const hasRepliedRef = { value: false };
  const replyPlan = createSlackReplyDeliveryPlan({
    replyToMode: prepared.replyToMode,
    incomingThreadTs,
    messageTs,
    hasRepliedRef,
    isThreadReply,
  });

  const typingTarget = statusThreadTs ? `${message.channel}/${statusThreadTs}` : message.channel;
  const typingCallbacks = createTypingCallbacks({
    start: async () => {
      didSetStatus = true;
      await ctx.setSlackThreadStatus({
        channelId: message.channel,
        threadTs: statusThreadTs,
        status: "is typing...",
      });
    },
    stop: async () => {
      if (!didSetStatus) {
        return;
      }
      didSetStatus = false;
      await ctx.setSlackThreadStatus({
        channelId: message.channel,
        threadTs: statusThreadTs,
        status: "",
      });
    },
    onStartError: (err) => {
      logTypingFailure({
        log: (message) => runtime.error?.(danger(message)),
        channel: "slack",
        action: "start",
        target: typingTarget,
        error: err,
      });
    },
    onStopError: (err) => {
      logTypingFailure({
        log: (message) => runtime.error?.(danger(message)),
        channel: "slack",
        action: "stop",
        target: typingTarget,
        error: err,
      });
    },
  });

  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId: route.agentId,
    channel: "slack",
    accountId: route.accountId,
  });

  const slackStreaming = resolveSlackStreamingConfig({
    streaming: account.config.streaming,
    streamMode: account.config.streamMode,
    nativeStreaming: account.config.nativeStreaming,
  });
  const previewStreamingEnabled = slackStreaming.mode !== "off";
  const streamingEnabled = isSlackStreamingEnabled({
    mode: slackStreaming.mode,
    nativeStreaming: slackStreaming.nativeStreaming,
  });
  const streamThreadHint = resolveSlackStreamingThreadHint({
    replyToMode: prepared.replyToMode,
    incomingThreadTs,
    messageTs,
    isThreadReply,
  });
  const useStreaming = shouldUseStreaming({
    streamingEnabled,
    threadTs: streamThreadHint,
  });
  let streamSession: SlackStreamSession | null = null;
  let streamFailed = false;
  let usedReplyThreadTs: string | undefined;
  const deliveredContentByPayload = new WeakMap<ReplyPayload, string>();

  const deliverNormally = async (
    payload: ReplyPayload,
    forcedThreadTs?: string,
  ): Promise<{ delivered: boolean; messageId?: string }> => {
    const replyThreadTs = forcedThreadTs ?? replyPlan.nextThreadTs();
    const delivery = await deliverReplies({
      replies: [payload],
      target: prepared.replyTarget,
      token: ctx.botToken,
      accountId: account.accountId,
      runtime,
      textLimit: ctx.textLimit,
      replyThreadTs,
      replyToMode: prepared.replyToMode,
      ...(slackIdentity ? { identity: slackIdentity } : {}),
    });
    // Record thread routing only after actual delivery.
    if (delivery.delivered) {
      if (replyThreadTs) {
        usedReplyThreadTs ??= replyThreadTs;
      }
      replyPlan.markSent();
      deliveredContentByPayload.set(payload, delivery.deliveredContent ?? payload.text ?? "");
    }
    return delivery;
  };

  const deliverWithStreaming = async (
    payload: ReplyPayload,
  ): Promise<{ delivered: boolean; messageId?: string }> => {
    if (streamFailed || hasMedia(payload) || !payload.text?.trim()) {
      return await deliverNormally(payload, streamSession?.threadTs);
    }

    const text = payload.text.trim();
    let plannedThreadTs: string | undefined;
    try {
      if (!streamSession) {
        const streamThreadTs = replyPlan.nextThreadTs();
        plannedThreadTs = streamThreadTs;
        if (!streamThreadTs) {
          logVerbose(
            "slack-stream: no reply thread target for stream start, falling back to normal delivery",
          );
          streamFailed = true;
          return await deliverNormally(payload);
        }

        streamSession = await startSlackStream({
          client: ctx.app.client,
          channel: message.channel,
          threadTs: streamThreadTs,
          text,
          teamId: ctx.teamId,
          userId: message.user,
        });
        usedReplyThreadTs ??= streamThreadTs;
        replyPlan.markSent();
        deliveredContentByPayload.set(payload, text);
        return { delivered: true };
      }

      await appendSlackStream({
        session: streamSession,
        text: "\n" + text,
      });
      deliveredContentByPayload.set(payload, text);
      return { delivered: true };
    } catch (err) {
      runtime.error?.(
        danger(`slack-stream: streaming API call failed: ${String(err)}, falling back`),
      );
      streamFailed = true;
      return await deliverNormally(payload, streamSession?.threadTs ?? plannedThreadTs);
    }
  };

  const { dispatcher, replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping({
    ...prefixOptions,
    humanDelay: resolveHumanDelayConfig(cfg, route.agentId),
    typingCallbacks,
    deliver: async (payload) => {
      deliveredContentByPayload.delete(payload);
      if (useStreaming) {
        return await deliverWithStreaming(payload);
      }

      const mediaCount = payload.mediaUrls?.length ?? (payload.mediaUrl ? 1 : 0);
      const draftMessageId = draftStream?.messageId();
      const draftChannelId = draftStream?.channelId();
      const finalText = payload.text;
      const canFinalizeViaPreviewEdit =
        previewStreamingEnabled &&
        streamMode !== "status_final" &&
        mediaCount === 0 &&
        !payload.isError &&
        typeof finalText === "string" &&
        finalText.trim().length > 0 &&
        typeof draftMessageId === "string" &&
        typeof draftChannelId === "string";

      if (canFinalizeViaPreviewEdit) {
        draftStream?.stop();
        try {
          await ctx.app.client.chat.update({
            token: ctx.botToken,
            channel: draftChannelId,
            ts: draftMessageId,
            text: finalText.trim(),
          });
          deliveredContentByPayload.set(payload, finalText.trim());
          return {
            delivered: true,
            messageId: draftMessageId,
          };
        } catch (err) {
          logVerbose(
            `slack: preview final edit failed; falling back to standard send (${String(err)})`,
          );
        }
      } else if (previewStreamingEnabled && streamMode === "status_final" && hasStreamedMessage) {
        try {
          const statusChannelId = draftStream?.channelId();
          const statusMessageId = draftStream?.messageId();
          if (statusChannelId && statusMessageId) {
            await ctx.app.client.chat.update({
              token: ctx.botToken,
              channel: statusChannelId,
              ts: statusMessageId,
              text: "Status: complete. Final answer posted below.",
            });
          }
        } catch (err) {
          logVerbose(`slack: status_final completion update failed (${String(err)})`);
        }
      } else if (mediaCount > 0) {
        await draftStream?.clear();
        hasStreamedMessage = false;
      }

      return await deliverNormally(payload);
    },
    onDelivery: (payload, info) => {
      const target = prepared.ctxPayload.To ?? message.channel;
      const hookContent = deliveredContentByPayload.get(payload) ?? payload.text ?? "";
      deliveredContentByPayload.delete(payload);
      if (info.success) {
        if (!info.delivered) {
          return;
        }
        emitMessageSentHooks({
          to: target,
          content: hookContent,
          success: true,
          channelId: "slack",
          accountId: route.accountId,
          conversationId: target,
          sessionKey: prepared.ctxPayload.SessionKey,
          messageId: info.messageId,
        });
        return;
      }
      emitMessageSentHooks({
        to: target,
        content: hookContent,
        success: false,
        error: info.error instanceof Error ? info.error.message : String(info.error),
        channelId: "slack",
        accountId: route.accountId,
        conversationId: target,
        sessionKey: prepared.ctxPayload.SessionKey,
      });
    },
    onError: (err, info) => {
      runtime.error?.(danger(`slack ${info.kind} reply failed: ${String(err)}`));
      typingCallbacks.onIdle?.();
    },
  });

  const draftStream = createSlackDraftStream({
    target: prepared.replyTarget,
    token: ctx.botToken,
    accountId: account.accountId,
    maxChars: Math.min(ctx.textLimit, 4000),
    resolveThreadTs: () => {
      const ts = replyPlan.nextThreadTs();
      if (ts) {
        usedReplyThreadTs ??= ts;
      }
      return ts;
    },
    onMessageSent: () => replyPlan.markSent(),
    log: logVerbose,
    warn: logVerbose,
  });
  let hasStreamedMessage = false;
  const streamMode = slackStreaming.draftMode;
  let appendRenderedText = "";
  let appendSourceText = "";
  let statusUpdateCount = 0;
  const updateDraftFromPartial = (text?: string) => {
    const trimmed = text?.trimEnd();
    if (!trimmed) {
      return;
    }

    if (streamMode === "append") {
      const next = applyAppendOnlyStreamUpdate({
        incoming: trimmed,
        rendered: appendRenderedText,
        source: appendSourceText,
      });
      appendRenderedText = next.rendered;
      appendSourceText = next.source;
      if (!next.changed) {
        return;
      }
      draftStream.update(next.rendered);
      hasStreamedMessage = true;
      return;
    }

    if (streamMode === "status_final") {
      statusUpdateCount += 1;
      if (statusUpdateCount > 1 && statusUpdateCount % 4 !== 0) {
        return;
      }
      draftStream.update(buildStatusFinalPreviewText(statusUpdateCount));
      hasStreamedMessage = true;
      return;
    }

    draftStream.update(trimmed);
    hasStreamedMessage = true;
  };
  const onDraftBoundary =
    useStreaming || !previewStreamingEnabled
      ? undefined
      : async () => {
          if (hasStreamedMessage) {
            draftStream.forceNewMessage();
            hasStreamedMessage = false;
            appendRenderedText = "";
            appendSourceText = "";
            statusUpdateCount = 0;
          }
        };

  const { queuedFinal, counts } = await dispatchInboundMessage({
    ctx: prepared.ctxPayload,
    cfg,
    dispatcher,
    replyOptions: {
      ...replyOptions,
      skillFilter: prepared.channelConfig?.skills,
      hasRepliedRef,
      disableBlockStreaming: useStreaming
        ? true
        : typeof account.config.blockStreaming === "boolean"
          ? !account.config.blockStreaming
          : undefined,
      onModelSelected,
      onPartialReply: useStreaming
        ? undefined
        : !previewStreamingEnabled
          ? undefined
          : async (payload) => {
              updateDraftFromPartial(payload.text);
            },
      onAssistantMessageStart: onDraftBoundary,
      onReasoningEnd: onDraftBoundary,
    },
  });
  await draftStream.flush();
  draftStream.stop();
  markDispatchIdle();

  // -----------------------------------------------------------------------
  // Finalize the stream if one was started
  // -----------------------------------------------------------------------
  const finalStream = streamSession as SlackStreamSession | null;
  if (finalStream && !finalStream.stopped) {
    try {
      await stopSlackStream({ session: finalStream });
    } catch (err) {
      runtime.error?.(danger(`slack-stream: failed to stop stream: ${String(err)}`));
    }
  }

  const anyReplyDelivered = queuedFinal || (counts.block ?? 0) > 0 || (counts.final ?? 0) > 0;

  // Record thread participation only when we actually delivered a reply and
  // know the thread ts that was used (set by deliverNormally, streaming start,
  // or draft stream). Falls back to statusThreadTs for edge cases.
  const participationThreadTs = usedReplyThreadTs ?? statusThreadTs;
  if (anyReplyDelivered && participationThreadTs) {
    recordSlackThreadParticipation(account.accountId, message.channel, participationThreadTs);
  }

  if (!anyReplyDelivered) {
    await draftStream.clear();
    if (prepared.isRoomish) {
      clearHistoryEntriesIfEnabled({
        historyMap: ctx.channelHistories,
        historyKey: prepared.historyKey,
        limit: ctx.historyLimit,
      });
    }
    return;
  }

  if (shouldLogVerbose()) {
    const finalCount = counts.final;
    logVerbose(
      `slack: delivered ${finalCount} reply${finalCount === 1 ? "" : "ies"} to ${prepared.replyTarget}`,
    );
  }

  removeAckReactionAfterReply({
    removeAfterReply: ctx.removeAckAfterReply,
    ackReactionPromise: prepared.ackReactionPromise,
    ackReactionValue: prepared.ackReactionValue,
    remove: () =>
      removeSlackReaction(
        message.channel,
        prepared.ackReactionMessageTs ?? "",
        prepared.ackReactionValue,
        {
          token: ctx.botToken,
          client: ctx.app.client,
        },
      ),
    onError: (err) => {
      logAckFailure({
        log: logVerbose,
        channel: "slack",
        target: `${message.channel}/${message.ts}`,
        error: err,
      });
    },
  });

  if (prepared.isRoomish) {
    clearHistoryEntriesIfEnabled({
      historyMap: ctx.channelHistories,
      historyKey: prepared.historyKey,
      limit: ctx.historyLimit,
    });
  }
}
