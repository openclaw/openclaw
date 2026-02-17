import type { PreparedSlackMessage } from "./types.js";
import { resolveHumanDelayConfig } from "../../../agents/identity.js";
import { dispatchInboundMessage } from "../../../auto-reply/dispatch.js";
import { clearHistoryEntriesIfEnabled } from "../../../auto-reply/reply/history.js";
import { createReplyDispatcherWithTyping } from "../../../auto-reply/reply/reply-dispatcher.js";
import { removeAckReactionAfterReply } from "../../../channels/ack-reactions.js";
import { logAckFailure, logTypingFailure } from "../../../channels/logging.js";
import { createReplyPrefixOptions } from "../../../channels/reply-prefix.js";
import { createTypingCallbacks } from "../../../channels/typing.js";
import { resolveStorePath, updateLastRoute } from "../../../config/sessions.js";
import { danger, logVerbose, shouldLogVerbose } from "../../../globals.js";
import { removeSlackReaction } from "../../actions.js";
import { createSlackDraftStream } from "../../draft-stream.js";
import {
  applyAppendOnlyStreamUpdate,
  buildStatusFinalPreviewText,
  resolveSlackStreamMode,
} from "../../stream-mode.js";
import { resolveSlackThreadTargets } from "../../threading.js";
import { createSlackReplyDeliveryPlan, deliverReplies } from "../replies.js";

export async function dispatchPreparedSlackMessage(prepared: PreparedSlackMessage) {
  const { ctx, account, message, route } = prepared;
  const cfg = ctx.cfg;
  const runtime = ctx.runtime;

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
      },
      ctx: prepared.ctxPayload,
    });
  }

  const { statusThreadTs } = resolveSlackThreadTargets({
    message,
    replyToMode: ctx.replyToMode,
  });

  const messageTs = message.ts ?? message.event_ts;
  const incomingThreadTs = message.thread_ts;
  let didSetStatus = false;

  // Shared mutable ref for "replyToMode=first". Both tool + auto-reply flows
  // mark this to ensure only the first reply is threaded.
  const hasRepliedRef = { value: false };
  const replyPlan = createSlackReplyDeliveryPlan({
    replyToMode: ctx.replyToMode,
    incomingThreadTs,
    messageTs,
    hasRepliedRef,
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

  const { dispatcher, replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping({
    ...prefixOptions,
    humanDelay: resolveHumanDelayConfig(cfg, route.agentId),
    deliver: async (payload) => {
      const mediaCount = payload.mediaUrls?.length ?? (payload.mediaUrl ? 1 : 0);
      const draftMessageId = draftStream?.messageId();
      const draftChannelId = draftStream?.channelId();
      const finalText = payload.text;
      const canFinalizeViaPreviewEdit =
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
          return;
        } catch (err) {
          logVerbose(
            `slack: preview final edit failed; falling back to standard send (${String(err)})`,
          );
        }
      } else if (streamMode === "status_final" && hasStreamedMessage) {
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

      const replyThreadTs = replyPlan.nextThreadTs();
      await deliverReplies({
        replies: [payload],
        target: prepared.replyTarget,
        token: ctx.botToken,
        accountId: account.accountId,
        runtime,
        textLimit: ctx.textLimit,
        replyThreadTs,
      });
      replyPlan.markSent();
    },
    onError: (err, info) => {
      runtime.error?.(danger(`slack ${info.kind} reply failed: ${String(err)}`));
      typingCallbacks.onIdle?.();
    },
    onReplyStart: typingCallbacks.onReplyStart,
    onIdle: typingCallbacks.onIdle,
  });

  const draftStream = createSlackDraftStream({
    target: prepared.replyTarget,
    token: ctx.botToken,
    accountId: account.accountId,
    maxChars: Math.min(ctx.textLimit, 4000),
    resolveThreadTs: () => replyPlan.nextThreadTs(),
    onMessageSent: () => replyPlan.markSent(),
    log: logVerbose,
    warn: logVerbose,
  });
  let hasStreamedMessage = false;
  const streamMode = resolveSlackStreamMode(account.config.streamMode);
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

  const { queuedFinal, counts } = await dispatchInboundMessage({
    ctx: prepared.ctxPayload,
    cfg,
    dispatcher,
    replyOptions: {
      ...replyOptions,
      skillFilter: prepared.channelConfig?.skills,
      hasRepliedRef,
      disableBlockStreaming:
        typeof account.config.blockStreaming === "boolean"
          ? !account.config.blockStreaming
          : undefined,
      onModelSelected,
      onPartialReply: async (payload) => {
        updateDraftFromPartial(payload.text);
      },
      onAssistantMessageStart: async () => {
        if (hasStreamedMessage) {
          draftStream.forceNewMessage();
          hasStreamedMessage = false;
          appendRenderedText = "";
          appendSourceText = "";
          statusUpdateCount = 0;
        }
      },
      onReasoningEnd: async () => {
        if (hasStreamedMessage) {
          draftStream.forceNewMessage();
          hasStreamedMessage = false;
          appendRenderedText = "";
          appendSourceText = "";
          statusUpdateCount = 0;
        }
      },
    },
  });
  await draftStream.flush();
  draftStream.stop();
  markDispatchIdle();

  const anyReplyDelivered = queuedFinal || (counts.block ?? 0) > 0 || (counts.final ?? 0) > 0;

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
