// Channel-visible receipt for a message that arrived while a run was active.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { logVerbose } from "../../globals.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { FollowupRun, ParkedSteerFallbackOutcome } from "./queue.js";
import { extractShortModelName } from "./response-prefix-template.js";

const routeReplyRuntimeLoader = createLazyImportLoader(() => import("./route-reply.runtime.js"));

/**
 * What happened to a busy-time message in steer mode. Fallback kinds mirror the
 * queue's disposition at the time of the receipt. Queue state can still change
 * later (a later overflow can evict an older entry), so fallback wording states
 * where the message is now and never promises an answer; "evicted" is the
 * follow-up notice when a queued fallback is later dropped.
 */
export type SteerReceiptKind = "steered" | ParkedSteerFallbackOutcome | "evicted";

const STEER_RECEIPT_TEXT: Readonly<Record<SteerReceiptKind, string>> = {
  steered: "🦞🛞 Current run steered with your new message.",
  queued: "⏳ Couldn't steer the current run; your message is queued behind it.",
  "at-cap":
    "⏳ Couldn't steer the current run; your message is queued behind it, but the queue is at its cap, so it may still be folded into a summary or dropped.",
  summarized:
    "⏳ Couldn't steer the current run and the queue is full; your message was folded into a queue summary behind it. If more messages overflow, older summary entries can be trimmed.",
  dropped:
    "⚠️ Couldn't steer the current run and the queue is full, so this message was dropped. Please send it again once the run finishes.",
  evicted:
    "⚠️ This message was dropped from the queue when newer messages overflowed it. Please send it again once the run finishes.",
};

/** Receipts are opt-in: without them steering stays silent, as it always has. */
function resolveSteerReceiptsEnabled(cfg: OpenClawConfig | undefined): boolean {
  return cfg?.messages?.queue?.steerReceipts === true;
}

/**
 * Tell the sender whether their busy-time message joined the running turn.
 *
 * Sent as a standalone reply to that message, never as its terminal reply: a
 * queued message still owes its real answer from the follow-up run, and a second
 * terminal reply for one inbound would collide with that answer. Best effort — a
 * failed receipt must never affect the steer or the run.
 */
export async function sendSteerReceipt(params: {
  followupRun: FollowupRun;
  kind: SteerReceiptKind;
  /** Provider id of the steered message; the queued run does not always carry it. */
  sourceMessageId?: string;
}): Promise<void> {
  const { followupRun, kind } = params;
  const cfg = followupRun.run.config;
  if (!resolveSteerReceiptsEnabled(cfg)) {
    return;
  }
  // Ambient room events are intentionally invisible; only acknowledge a user's own message.
  if (followupRun.currentInboundEventKind === "room_event") {
    return;
  }
  const channel = followupRun.originatingChannel;
  const to = followupRun.originatingTo;
  if (!channel || !to) {
    return;
  }
  try {
    const { isRoutableChannel, routeReply } = await routeReplyRuntimeLoader.load();
    if (!isRoutableChannel(channel)) {
      return;
    }
    const { provider, model, thinkLevel } = followupRun.run;
    const sourceMessageId = followupRun.messageId ?? params.sourceMessageId;
    const result = await routeReply({
      // Quote the exact message the receipt is about, independent of the channel's reply mode.
      // Name the message explicitly: channels without a reply-transport resolver (Telegram)
      // only quote an explicit replyToId; resolver channels also honour replyToCurrent.
      payload: {
        text: STEER_RECEIPT_TEXT[kind],
        replyToCurrent: true,
        ...(sourceMessageId ? { replyToId: sourceMessageId } : {}),
      },
      channel,
      to,
      agentId: followupRun.run.agentId,
      sessionKey: followupRun.run.sessionKey,
      accountId: followupRun.originatingAccountId,
      requesterSenderId: followupRun.run.senderId,
      requesterSenderName: followupRun.run.senderName,
      requesterSenderUsername: followupRun.run.senderUsername,
      requesterSenderE164: followupRun.run.senderE164,
      threadId: followupRun.originatingThreadId,
      currentMessageId: sourceMessageId,
      cfg,
      // A receipt is not conversation content; keep it out of the model's history.
      mirror: false,
      replyKind: "tool",
      // The operator's responsePrefix applies to every bot message; fill it from the active run.
      responsePrefixContext: {
        provider,
        model: extractShortModelName(model),
        modelFull: `${provider}/${model}`,
        thinkingLevel: thinkLevel ?? "off",
      },
    });
    if (!result.delivered && !result.suppressed) {
      logVerbose(`queue: steer receipt (${kind}) not delivered: ${result.error ?? "unknown"}`);
    }
  } catch (error) {
    logVerbose(`queue: steer receipt (${kind}) failed: ${formatErrorMessage(error)}`);
  }
}

/**
 * After a fallback receipt, tell the sender if the queue later evicts that message.
 *
 * `drop: old` reports the eviction through `onQueueDisposition("queue-cap-old")`;
 * the existing observer keeps running first. The notice waits for the fallback
 * receipt so it always arrives after it, and fires at most once.
 */
export function armSteerReceiptEvictionNotice(params: {
  followupRun: FollowupRun;
  sourceMessageId?: string;
  after?: Promise<void>;
}): void {
  const { followupRun } = params;
  if (!resolveSteerReceiptsEnabled(followupRun.run.config)) {
    return;
  }
  const observe = followupRun.onQueueDisposition;
  let notified = false;
  followupRun.onQueueDisposition = (disposition) => {
    observe?.(disposition);
    if (notified || disposition !== "queue-cap-old") {
      return;
    }
    notified = true;
    void (params.after ?? Promise.resolve()).then(() =>
      sendSteerReceipt({
        followupRun,
        kind: "evicted",
        sourceMessageId: params.sourceMessageId,
      }),
    );
  };
}
