import { resolveHumanDelayConfig } from "../../../agents/identity.js";
import { dispatchInboundMessage } from "../../../auto-reply/dispatch.js";
import { clearHistoryEntriesIfEnabled } from "../../../auto-reply/reply/history.js";
import {
  createReplyDispatcherWithTyping,
  type ReplyDispatchKind,
} from "../../../auto-reply/reply/reply-dispatcher.js";
import { isSilentReplyText, SILENT_REPLY_TOKEN } from "../../../auto-reply/tokens.js";
import type { ReplyPayload } from "../../../auto-reply/types.js";
import { removeAckReactionAfterReply } from "../../../channels/ack-reactions.js";
import { logAckFailure, logTypingFailure } from "../../../channels/logging.js";
import { createReplyPrefixOptions } from "../../../channels/reply-prefix.js";
import { createTypingCallbacks } from "../../../channels/typing.js";
import { resolveStorePath, updateLastRoute } from "../../../config/sessions.js";
import { danger, logVerbose, shouldLogVerbose } from "../../../globals.js";
import { resolveAgentOutboundIdentity } from "../../../infra/outbound/identity.js";
import { getAgentScopedMediaLocalRoots } from "../../../media/local-roots.js";
import { resolvePinnedMainDmOwnerFromAllowlist } from "../../../security/dm-policy-shared.js";
import { truncateUtf16Safe } from "../../../utils.js";
import { reactSlackMessage, removeSlackReaction } from "../../actions.js";
import { createSlackDraftStream, type SlackDraftStream } from "../../draft-stream.js";
import { normalizeSlackOutboundText } from "../../format.js";
import { sendMessageSlack } from "../../send.js";
import { recordSlackThreadParticipation } from "../../sent-thread-cache.js";
import {
  applyAppendOnlyStreamUpdate,
  buildStatusFinalPreviewText,
  resolveSlackStreamingConfig,
} from "../../stream-mode.js";
import type { SlackStreamSession } from "../../streaming.js";
import { appendSlackStream, startSlackStream, stopSlackStream } from "../../streaming.js";
import { resolveSlackThreadTargets } from "../../threading.js";
import { normalizeSlackAllowOwnerEntry } from "../allow-list.js";
import { createSlackReplyDeliveryPlan, deliverReplies, resolveSlackThreadTs } from "../replies.js";
import { applySlackFinalReplyGuards } from "./final-answer-guard.js";
import type { PreparedSlackMessage } from "./types.js";

function hasMedia(payload: ReplyPayload): boolean {
  return Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
}

export function isSlackSuppressedReplyPayload(payload: ReplyPayload): boolean {
  const trimmed = payload.text?.trim();
  // This Slack path only renders text/media. Flags like isError/channelData do
  // not create a user-visible send on their own, so blank or silent no-media
  // payloads stay intentionally suppressible here.
  return !hasMedia(payload) && (!trimmed || isSilentReplyText(trimmed, SILENT_REPLY_TOKEN));
}

export function shouldApplySlackFinalReplyGuards(kind: ReplyDispatchKind): boolean {
  // Tool/block updates still flow through the shared dispatcher for other
  // channels/observers. Only the final Slack delivery should hit the final-only
  // guard chain so intermediate progress remains intact elsewhere.
  return kind === "final";
}

export function shouldSkipSlackReplyDelivery(params: {
  kind: ReplyDispatchKind;
  finalOnlyReplies: boolean;
}): boolean {
  return params.finalOnlyReplies && params.kind !== "final";
}

export function didSlackDispatchDeliverAnyReply(params: {
  deliveredReplyCount: number;
  queuedFinal: boolean;
  counts: { block?: number; final?: number };
}): boolean {
  // queuedFinal/counts reflect dispatcher intent, not proof that Slack accepted
  // a message. Suppressed finals can queue successfully while intentionally
  // delivering nothing, so only actual sends/edits/stream starts count here.
  return params.deliveredReplyCount > 0;
}

export function formatSlackSuppressedReplyPreview(text?: string): string {
  return (text ?? "").trim().replace(/\s+/g, " ").slice(0, 120);
}

export function requireSlackDispatchResult<T>(result: T | undefined, error: unknown): T {
  if (error !== undefined) {
    throw error;
  }
  if (result === undefined) {
    throw new Error("Slack dispatch finished without a result.");
  }
  return result;
}

export function applySlackFinalReplyGuardsSafely(
  params: Parameters<typeof applySlackFinalReplyGuards>[0] & {
    onError?: (err: unknown) => void;
  },
): ReplyPayload {
  try {
    return applySlackFinalReplyGuards(params);
  } catch (err) {
    let textLength = 0;
    let hasMedia = false;
    let hasChannelData = false;
    let isError = false;
    try {
      textLength = typeof params.payload.text === "string" ? params.payload.text.length : 0;
    } catch {}
    try {
      hasMedia = Boolean(params.payload.mediaUrl || (params.payload.mediaUrls?.length ?? 0) > 0);
    } catch {}
    try {
      hasChannelData = params.payload.channelData != null;
    } catch {}
    try {
      isError = params.payload.isError === true;
    } catch {}
    const payloadSummary = [
      `textLength=${textLength}`,
      `hasMedia=${hasMedia}`,
      `hasChannelData=${hasChannelData}`,
      `isError=${isError}`,
    ].join(",");
    const causeMessage =
      err instanceof Error
        ? err.message
        : typeof err === "string"
          ? err
          : err == null
            ? "unknown guard error"
            : "non-Error guard throw";
    const cause = err instanceof Error ? err : new Error(causeMessage);
    params.onError?.(
      new Error(
        `Final reply guard failed (incidentRootOnly=${params.incidentRootOnly === true}, isThreadReply=${params.isThreadReply === true}, ${payloadSummary}): ${causeMessage}`,
        { cause },
      ),
    );
    return params.payload;
  }
}

export async function settleSlackDispatchAfterRun(params: {
  draftStream: Pick<SlackDraftStream, "stop">;
  markDispatchIdle: () => void;
  streamSession: SlackStreamSession | null;
  stopStream?: typeof stopSlackStream;
  onStopStreamError?: (err: unknown) => void;
  onRemoveAckReaction?: () => void;
}): Promise<void> {
  params.draftStream.stop();
  params.markDispatchIdle();
  params.onRemoveAckReaction?.();
  const finalStream = params.streamSession;
  if (!finalStream || finalStream.stopped) {
    return;
  }
  try {
    await (params.stopStream ?? stopSlackStream)({ session: finalStream });
  } catch (err) {
    params.onStopStreamError?.(err);
  }
}

const REASONING_PROGRESS_MAX_CHARS = 1200;

function buildSlackReasoningProgressText(text?: string): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) {
    return undefined;
  }
  const withoutPrefix = trimmed.replace(/^reasoning:\s*/i, "");
  const normalized = withoutPrefix
    .split("\n")
    .map((line) => {
      const stripped = line.trim();
      if (stripped.startsWith("_") && stripped.endsWith("_") && stripped.length > 1) {
        return stripped.slice(1, -1).trim();
      }
      return stripped;
    })
    .map((line) => line.replace(/\s+/g, " ").replace(/^[-*]\s+/, ""))
    .filter(Boolean)
    .join("\n")
    .trim();
  if (!normalized) {
    return undefined;
  }
  const bulletLines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `- ${line}`)
    .join("\n");
  const structured = `*Status update*\nstate: analyzing\nprogress:\n${bulletLines}`;
  const truncated = truncateUtf16Safe(structured, REASONING_PROGRESS_MAX_CHARS).trimEnd();
  const ellipsis = structured.length > truncated.length ? "\n..." : "";
  return `${truncated}${ellipsis}`;
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

/**
 * Resolves Slack reply streaming behavior from normalized channel policy.
 * Incident-root-only channels disable previews, native partial streaming, and
 * progress acks so no partial reasoning leaks into incident threads. Also
 * enables final-only reply mode (suppressing tool/block callbacks) and
 * disables the typing auto-stop TTL for long-running investigations.
 */
export function resolveSlackReplyStreamingPolicy(params: {
  mode: "off" | "partial" | "block" | "progress";
  nativeStreaming: boolean;
  incidentRootOnly?: boolean;
}): {
  previewStreamingEnabled: boolean;
  streamingEnabled: boolean;
  sendProgressAck: boolean;
  finalOnlyReplies: boolean;
  disableTypingTtl: boolean;
} {
  if (params.incidentRootOnly) {
    // Incident threads still need visible liveness during long investigations,
    // so typing stays active (disableTypingTtl: true). Reply content is still
    // final-only: no previews, no tool/block chatter, only the final summary
    // lands in the thread. This matches the SRE response discipline of one
    // substantive reply and zero progress chatter in incident threads. The
    // policy is resolved per dispatch, so follow-up turns re-evaluate it from
    // current thread config rather than mutating mid-run.
    return {
      previewStreamingEnabled: false,
      streamingEnabled: false,
      sendProgressAck: false,
      finalOnlyReplies: true,
      disableTypingTtl: true,
    };
  }

  return {
    previewStreamingEnabled: params.mode !== "off",
    streamingEnabled: isSlackStreamingEnabled({
      mode: params.mode,
      nativeStreaming: params.nativeStreaming,
    }),
    sendProgressAck: params.mode === "progress",
    finalOnlyReplies: false,
    disableTypingTtl: false,
  };
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

export function shouldForceSlackDraftBoundary(params: {
  hasStreamedMessage: boolean;
  draftMode: "replace" | "status_final" | "append";
}): boolean {
  return params.hasStreamedMessage && params.draftMode !== "status_final";
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
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(cfg, route.agentId);

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
    const pinnedMainDmOwner = resolvePinnedMainDmOwnerFromAllowlist({
      dmScope: cfg.session?.dmScope,
      allowFrom: ctx.allowFrom,
      normalizeEntry: normalizeSlackAllowOwnerEntry,
    });
    const senderRecipient = message.user?.trim().toLowerCase();
    const skipMainUpdate =
      pinnedMainDmOwner &&
      senderRecipient &&
      pinnedMainDmOwner.trim().toLowerCase() !== senderRecipient;
    if (skipMainUpdate) {
      logVerbose(
        `slack: skip main-session last route for ${senderRecipient} (pinned owner ${pinnedMainDmOwner})`,
      );
    } else {
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
  const streamingPolicy = resolveSlackReplyStreamingPolicy({
    mode: slackStreaming.mode,
    nativeStreaming: slackStreaming.nativeStreaming,
    incidentRootOnly: prepared.channelConfig?.incidentRootOnly === true,
  });
  const {
    previewStreamingEnabled,
    streamingEnabled,
    sendProgressAck,
    finalOnlyReplies,
    disableTypingTtl,
  } = streamingPolicy;
  const typingTarget = statusThreadTs ? `${message.channel}/${statusThreadTs}` : message.channel;
  const typingReaction = ctx.typingReaction;
  const typingCallbacks = createTypingCallbacks({
    start: async () => {
      didSetStatus = true;
      await ctx.setSlackThreadStatus({
        channelId: message.channel,
        threadTs: statusThreadTs,
        status: "is typing...",
      });
      if (typingReaction && message.ts) {
        await reactSlackMessage(message.channel, message.ts, typingReaction, {
          token: ctx.botToken,
          client: ctx.app.client,
        }).catch(() => {});
      }
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
      if (typingReaction && message.ts) {
        await removeSlackReaction(message.channel, message.ts, typingReaction, {
          token: ctx.botToken,
          client: ctx.app.client,
        }).catch(() => {});
      }
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
    maxDurationMs: disableTypingTtl ? 0 : undefined,
  });
  let didSendProgressAck = false;
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

  const maybeSendProgressAck = async (): Promise<void> => {
    if (!sendProgressAck || didSendProgressAck) {
      return;
    }
    didSendProgressAck = true;
    const ackThreadTs = resolveSlackThreadTs({
      replyToMode: ctx.replyToMode,
      incomingThreadTs,
      messageTs,
      hasReplied: hasRepliedRef.value,
      isThreadReply,
    });
    if (!message.ts) {
      return;
    }
    try {
      await reactSlackMessage(message.channel, message.ts, "👀", {
        token: ctx.botToken,
        client: ctx.app.client,
        accountId: account.accountId,
      });
    } catch (err) {
      const errText = String(err);
      runtime.error?.(danger(`slack: failed to send progress ack reaction: ${errText}`));
      if (errText.includes("missing_scope")) {
        try {
          await sendMessageSlack(prepared.replyTarget, "👀", {
            token: ctx.botToken,
            threadTs: ackThreadTs,
            accountId: account.accountId,
          });
        } catch (fallbackErr) {
          runtime.error?.(
            danger(`slack: failed to send progress ack fallback message: ${String(fallbackErr)}`),
          );
        }
      }
    }
  };

  const deliverNormally = async (payload: ReplyPayload, forcedThreadTs?: string): Promise<void> => {
    const replyThreadTs = forcedThreadTs ?? replyPlan.nextThreadTs();
    const deliveredCount = await deliverReplies({
      replies: [payload],
      target: prepared.replyTarget,
      token: ctx.botToken,
      accountId: account.accountId,
      mediaLocalRoots,
      runtime,
      textLimit: ctx.textLimit,
      replyThreadTs,
      replyToMode: prepared.replyToMode,
      ...(slackIdentity ? { identity: slackIdentity } : {}),
    });
    if (deliveredCount === 0) {
      return;
    }
    // Record the thread ts only after confirmed delivery success.
    if (replyThreadTs) {
      usedReplyThreadTs ??= replyThreadTs;
    }
    replyPlan.markSent();
    deliveredReplyCount += deliveredCount;
  };

  const deliverWithStreaming = async (payload: ReplyPayload): Promise<void> => {
    if (streamFailed || hasMedia(payload) || !payload.text?.trim()) {
      await deliverNormally(payload, streamSession?.threadTs);
      return;
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
          await deliverNormally(payload);
          return;
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
        deliveredReplyCount += 1;
        return;
      }

      await appendSlackStream({
        session: streamSession,
        text: "\n" + text,
      });
    } catch (err) {
      runtime.error?.(
        danger(`slack-stream: streaming API call failed: ${String(err)}, falling back`),
      );
      streamFailed = true;
      await deliverNormally(payload, streamSession?.threadTs ?? plannedThreadTs);
    }
  };

  const { dispatcher, replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping({
    ...prefixOptions,
    humanDelay: resolveHumanDelayConfig(cfg, route.agentId),
    typingCallbacks,
    deliver: async (incomingPayload, info) => {
      if (
        shouldSkipSlackReplyDelivery({
          kind: info.kind,
          finalOnlyReplies,
        })
      ) {
        const skipMessage = `slack: skipped non-final ${info.kind} reply in final-only thread`;
        if (shouldLogVerbose()) {
          logVerbose(skipMessage);
        } else {
          runtime.log?.(skipMessage);
        }
        return;
      }
      const inboundText =
        message.text ?? prepared.ctxPayload.CommandBody ?? prepared.ctxPayload.RawBody;
      const shouldGuardFinalReply = shouldApplySlackFinalReplyGuards(info.kind);
      const payload = shouldGuardFinalReply
        ? applySlackFinalReplyGuardsSafely({
            questionText: inboundText,
            inboundText,
            incidentRootOnly: prepared.channelConfig?.incidentRootOnly === true,
            isThreadReply,
            payload: incomingPayload,
            onError: (err) => {
              runtime.error?.(danger(`slack-guard: final reply guard failed: ${String(err)}`));
            },
          })
        : incomingPayload;
      if (shouldGuardFinalReply && isSlackSuppressedReplyPayload(payload)) {
        if (shouldLogVerbose()) {
          const suppressedPreview = formatSlackSuppressedReplyPreview(incomingPayload.text);
          logVerbose(
            `slack: suppressed progress-only final reply${suppressedPreview ? ` (${suppressedPreview})` : ""}`,
          );
        }
        // This only skips the Slack send. Outer post-dispatch cleanup still
        // runs after dispatchInboundMessage resolves and sees no delivery.
        return;
      }
      if (useStreaming) {
        await deliverWithStreaming(payload);
        return;
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
            text: normalizeSlackOutboundText(finalText.trim()),
          });
          deliveredReplyCount += 1;
          return;
        } catch (err) {
          logVerbose(
            `slack: preview final edit failed; falling back to standard send (${String(err)})`,
          );
        }
      } else if (previewStreamingEnabled && streamMode === "status_final" && hasStreamedMessage) {
        // status_final preview is a temporary status line; remove it once the
        // final reply is ready instead of leaving an extra completion banner.
        await draftStream?.clear();
        hasStreamedMessage = false;
        statusUpdateCount = 0;
        lastReasoningProgressText = "";
      } else if (mediaCount > 0) {
        await draftStream?.clear();
        hasStreamedMessage = false;
      }

      await deliverNormally(payload);
    },
    onError: (err, info) => {
      runtime.error?.(danger(`slack ${info.kind} reply failed: ${String(err)}`));
      typingCallbacks.onIdle?.();
    },
    onReplyStart: async () => {
      await maybeSendProgressAck();
      await typingCallbacks.onReplyStart();
    },
    onIdle: typingCallbacks.onIdle,
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
  let lastReasoningProgressText = "";
  let deliveredReplyCount = 0;
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
  const updateDraftFromReasoning = (text?: string) => {
    const trimmed = text?.trimEnd();
    if (!trimmed) {
      return;
    }
    if (streamMode === "status_final") {
      const reasoningProgressText = buildSlackReasoningProgressText(trimmed);
      if (!reasoningProgressText || reasoningProgressText === lastReasoningProgressText) {
        return;
      }
      lastReasoningProgressText = reasoningProgressText;
      draftStream.update(reasoningProgressText);
      hasStreamedMessage = true;
      return;
    }
    updateDraftFromPartial(trimmed);
  };
  const onDraftBoundary =
    useStreaming || !previewStreamingEnabled
      ? undefined
      : async () => {
          if (
            shouldForceSlackDraftBoundary({
              hasStreamedMessage,
              draftMode: streamMode,
            })
          ) {
            draftStream.forceNewMessage();
            hasStreamedMessage = false;
            appendRenderedText = "";
            appendSourceText = "";
            statusUpdateCount = 0;
            lastReasoningProgressText = "";
          }
        };

  let dispatchResult: Awaited<ReturnType<typeof dispatchInboundMessage>> | undefined;
  let dispatchError: unknown;
  try {
    dispatchResult = await dispatchInboundMessage({
      ctx: prepared.ctxPayload,
      cfg,
      dispatcher,
      replyOptions: {
        ...replyOptions,
        skillFilter: prepared.channelConfig?.skills,
        finalOnlyReplies,
        typingTtlMs: disableTypingTtl ? 0 : undefined,
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
        onReasoningStream: useStreaming
          ? undefined
          : !previewStreamingEnabled
            ? undefined
            : async (payload) => {
                updateDraftFromReasoning(payload.text);
              },
        onAssistantMessageStart: onDraftBoundary,
        onReasoningEnd: onDraftBoundary,
      },
    });
    await draftStream.flush();
  } catch (err) {
    dispatchError = err;
  } finally {
    await settleSlackDispatchAfterRun({
      draftStream,
      markDispatchIdle,
      streamSession,
      onRemoveAckReaction: () =>
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
        }),
      onStopStreamError: (err) => {
        runtime.error?.(danger(`slack-stream: failed to stop stream: ${String(err)}`));
      },
    });
  }
  const { queuedFinal, counts } = requireSlackDispatchResult(dispatchResult, dispatchError);

  const anyReplyDelivered = didSlackDispatchDeliverAnyReply({
    deliveredReplyCount,
    queuedFinal,
    counts,
  });

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
    const finalCount = deliveredReplyCount;
    logVerbose(
      `slack: delivered ${finalCount} message${finalCount === 1 ? "" : "s"} to ${prepared.replyTarget}`,
    );
  }

  if (prepared.isRoomish) {
    clearHistoryEntriesIfEnabled({
      historyMap: ctx.channelHistories,
      historyKey: prepared.historyKey,
      limit: ctx.historyLimit,
    });
  }
}
