import type { ReplyDispatchKind } from "../../../auto-reply/reply/reply-dispatcher.js";
import type { ReplyPayload } from "../../../auto-reply/types.js";
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
import { createSlackWebClient } from "../../client.js";
import { markdownToSlackMrkdwn } from "../../format.js";
import type { SlackStreamHandle } from "../../stream.js";
import { startSlackStream } from "../../stream.js";
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
  /** Update the thread status indicator with a custom message. */
  const updateStatus = async (status: string) => {
    didSetStatus = true;
    await ctx.setSlackThreadStatus({
      channelId: message.channel,
      threadTs: statusThreadTs,
      status,
    });
  };
  const typingCallbacks = createTypingCallbacks({
    start: async () => {
      await updateStatus("is typing...");
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

  // Slack native streaming: when enabled, block/final replies update a single
  // live message via chat.startStream/appendStream/stopStream instead of
  // posting separate messages.  Tool results still use normal delivery.
  const slackStreamingEnabled = account.config.streaming === true;
  // Wrapped in an object so TypeScript can track mutations across closures.
  const streamState = { handle: null as SlackStreamHandle | null, failed: false };

  const deliverNormal = async (payload: ReplyPayload) => {
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
  };

  const deliverStreaming = async (payload: ReplyPayload, kind: ReplyDispatchKind) => {
    // Tool results are always sent as separate messages.
    // Update status to reflect tool activity when delivering tool output.
    if (kind === "tool") {
      const toolText = payload.text?.trim();
      if (toolText) {
        const statusHint = extractToolStatusHint(toolText);
        if (statusHint) {
          void updateStatus(statusHint).catch(() => {});
        }
      }
      await deliverNormal(payload);
      return;
    }
    if (streamState.failed) {
      await deliverNormal(payload);
      return;
    }

    const text = payload.text?.trim();
    if (!text) {
      // Media-only or empty — can't stream, use normal path.
      if (payload.mediaUrl || payload.mediaUrls?.length) {
        await deliverNormal(payload);
      }
      return;
    }

    // Start stream on first non-tool delivery.
    if (!streamState.handle) {
      try {
        // Slack's chat.startStream requires thread_ts.  If the reply plan
        // doesn't give us one (e.g. replyToMode=off), fall back to the
        // incoming message timestamp so a thread is created.
        const replyThreadTs = replyPlan.nextThreadTs() ?? incomingThreadTs ?? messageTs;
        const client = createSlackWebClient(ctx.botToken);
        // Always use message.channel — it's the actual Slack channel/DM ID
        // that the API requires.  prepared.replyTarget may contain a user ID
        // prefix (user:UXXXX) which isn't a valid channel for the streaming API.
        streamState.handle = await startSlackStream({
          client,
          channel: message.channel,
          threadTs: replyThreadTs,
        });
        replyPlan.markSent();
      } catch (err) {
        logVerbose(`slack: stream start failed, falling back to normal delivery: ${String(err)}`);
        streamState.failed = true;
        await deliverNormal(payload);
        return;
      }
    }

    // Append converted mrkdwn text to the stream.
    try {
      await streamState.handle.append(markdownToSlackMrkdwn(text));
    } catch (err) {
      logVerbose(`slack: stream append failed, falling back: ${String(err)}`);
      streamState.failed = true;
      // Stop the broken stream and deliver normally.
      try {
        await streamState.handle.stop();
      } catch { /* ignore */ }
      streamState.handle = null;
      await deliverNormal(payload);
    }
  };

  const { dispatcher, replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping({
    ...prefixOptions,
    humanDelay: resolveHumanDelayConfig(cfg, route.agentId),
    deliver: slackStreamingEnabled
      ? async (payload, info) => deliverStreaming(payload, info.kind)
      : async (payload) => deliverNormal(payload),
    onError: (err, info) => {
      runtime.error?.(danger(`slack ${info.kind} reply failed: ${String(err)}`));
      typingCallbacks.onIdle?.();
    },
    onReplyStart: typingCallbacks.onReplyStart,
    onIdle: typingCallbacks.onIdle,
  });

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
    },
  });
  markDispatchIdle();

  // Finalize the Slack stream if one is active.
  if (streamState.handle) {
    try {
      await streamState.handle.stop();
    } catch (err) {
      logVerbose(`slack: stream stop failed: ${String(err)}`);
    }
    streamState.handle = null;
  }

  const anyReplyDelivered = queuedFinal || (counts.block ?? 0) > 0 || (counts.final ?? 0) > 0;

  if (!anyReplyDelivered) {
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

// Tool result text often starts with a header like "Used **vault_read**" or
// "Called obsidian_search".  Extract a short status hint from it.
const TOOL_HEADER_RE = /^(?:Used|Called|Running|Calling|Searching|Reading)\s+\*{0,2}(\w[\w.-]*)\*{0,2}/i;

function extractToolStatusHint(toolText: string): string | undefined {
  const match = TOOL_HEADER_RE.exec(toolText);
  if (!match?.[1]) {
    return undefined;
  }
  const toolName = match[1].replace(/[_-]/g, " ");
  return `Using ${toolName}...`;
}
