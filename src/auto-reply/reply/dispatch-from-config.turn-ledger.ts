// Per-dispatch settled-delivery ledger (#114768). Answers "did this turn produce
// a visible message" from transport settlement, not queue/route admission. Every
// dispatcher send in the dispatch pipeline uses the shared send operation and every
// routed transport result is recorded, so no delivery lane can bypass the
// no-visible-reply fallback gate with a fresh inference flag.
import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyDeliveryState } from "../../agents/reply-completion.js";
import type { OutboundPayloadPlan } from "../../infra/outbound/reply-payload-parts.js";
import { isReplyPayloadTerminalContent, type ReplyPayload } from "../reply-payload.js";
import { runWithDispatchAbortSignal } from "./dispatch-from-config.abort.js";
import {
  ReplyDispatchDeliveryError,
  resolveRoutedReplyDeliveryOutcome,
} from "./reply-dispatch-outcome.js";
import {
  captureReplyDispatchDeliveryOutcome,
  type ReplyDispatchDeliveryOutcome,
  waitForReplyDispatcherIdle,
} from "./reply-dispatcher.js";
import type {
  ReplyDispatchKind,
  ReplyDispatchOperation,
  ReplyDispatcher,
} from "./reply-dispatcher.types.js";

// Failsafe for transports that never settle: the completion barrier bounds
// delivery waits at the operation layer, and finalization must not out-wait it.
const SETTLE_QUEUED_TIMEOUT_MS = 30_000;

const RAW_REPLY_SEND_METHODS = {
  tool: "sendToolResult",
  block: "sendBlockReply",
  final: "sendFinalReply",
} as const;

type LedgerQueuedSend = {
  queued: boolean;
  outcome?: Promise<ReplyDispatchDeliveryOutcome>;
  hasPendingDelivery?: () => boolean;
};

type LedgerSettleResult = "settled" | "aborted" | "timed-out";

export async function requireQueuedReplyDelivery(params: {
  delivery: LedgerQueuedSend;
  dispatcher: Pick<ReplyDispatcher, "supportsSettledReceipt" | "waitForIdle">;
  abortSignal: AbortSignal | undefined;
}): Promise<void> {
  if (!params.delivery.queued) {
    throw new Error("queued reply delivery failed");
  }
  const outcome = params.delivery.outcome;
  if (!outcome) {
    const receipt = await waitForReplyDispatcherIdle(params.dispatcher, params.abortSignal);
    if (
      params.dispatcher.supportsSettledReceipt === true &&
      receipt?.anyVisibleDelivered !== true
    ) {
      throw new Error("queued reply delivery failed");
    }
    return;
  }
  const settledOutcome = await runWithDispatchAbortSignal(params.abortSignal, () => outcome);
  if (settledOutcome !== "delivered") {
    throw new ReplyDispatchDeliveryError(settledOutcome);
  }
}

export function createReplyTurnLedger(dispatcher: ReplyDispatcher) {
  const outcomes = new Set<ReplyDispatchDeliveryOutcome>();
  let pendingDelivery = false;
  let terminalDelivery: ReplyDeliveryState = "missing";
  const mayHaveDelivered = () => outcomes.has("delivered") || outcomes.has("failed-deliver");
  const recordDelivery = (
    kind: ReplyDispatchKind,
    payload: ReplyPayload,
    outcome: ReplyDispatchDeliveryOutcome,
    pending: boolean,
  ) => {
    pendingDelivery ||= pending;
    if (!hasOutboundReplyContent(payload, { trimText: true })) {
      return;
    }
    outcomes.add(outcome);
    if (kind === "tool" || !isReplyPayloadTerminalContent(payload)) {
      return;
    }
    if (outcome === "delivered" && !pending) {
      terminalDelivery = "delivered";
    } else if (
      terminalDelivery !== "delivered" &&
      (pending || outcome === "failed-deliver" || outcome === "recovery-owned")
    ) {
      terminalDelivery = "pending";
    }
  };
  const sendOperation = (
    kind: ReplyDispatchKind,
    operation: ReplyDispatchOperation,
  ): LedgerQueuedSend => {
    const payload = operation.kind === "prepared" ? operation.plan.payload : operation.payload;
    const capture =
      dispatcher.supportsSettledReceipt === true
        ? captureReplyDispatchDeliveryOutcome(payload)
        : undefined;
    const queued =
      operation.kind === "prepared" && dispatcher.sendPreparedReply
        ? dispatcher.sendPreparedReply(kind, operation.plan)
        : dispatcher[RAW_REPLY_SEND_METHODS[kind]](payload);
    if (!queued) {
      return { queued: false };
    }
    if (!capture || !capture.isTracked()) {
      // Missing or copy-lost receipts prove admission, not non-delivery.
      // Retain uncertainty so a terminal reply cannot be sent twice.
      recordDelivery(kind, payload, "failed-deliver", false);
      return { queued: true };
    }
    const outcome = capture.promise.then((settled) => {
      recordDelivery(kind, payload, settled, capture.hasPendingDelivery());
      return settled;
    });
    return { queued: true, outcome, hasPendingDelivery: capture.hasPendingDelivery };
  };
  return {
    sendQueued: (kind: ReplyDispatchKind, payload: ReplyPayload) =>
      sendOperation(kind, { kind: "raw", payload }),
    sendPreparedQueued: (kind: ReplyDispatchKind, plan: OutboundPayloadPlan) =>
      sendOperation(kind, { kind: "prepared", plan }),
    recordRoutedDelivery(
      kind: ReplyDispatchKind,
      payload: ReplyPayload,
      result: Parameters<typeof resolveRoutedReplyDeliveryOutcome>[0],
    ) {
      const outcome = resolveRoutedReplyDeliveryOutcome(result);
      recordDelivery(
        kind,
        payload,
        outcome,
        result.queueCustody === "held" || result.ambiguous === true || outcome === "recovery-owned",
      );
    },
    // Only settlement proves visibility after beforeDeliver hooks and transport delivery.
    async settleQueued(abortSignal?: AbortSignal): Promise<LedgerSettleResult> {
      if (abortSignal?.aborted) {
        return "aborted";
      }
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), SETTLE_QUEUED_TIMEOUT_MS);
      timer.unref?.();
      try {
        const receipt = await waitForReplyDispatcherIdle(
          dispatcher,
          abortSignal ? AbortSignal.any([abortSignal, deadline.signal]) : deadline.signal,
        );
        if (abortSignal?.aborted) {
          return "aborted";
        }
        if (deadline.signal.aborted) {
          return "timed-out";
        }
        if (dispatcher.supportsSettledReceipt === true && receipt) {
          for (const counts of Object.values(receipt.counts)) {
            if (counts.delivered > 0) {
              outcomes.add("delivered");
            }
            if (counts.failedAfterSend > 0) {
              outcomes.add("failed-deliver");
            }
          }
        }
        pendingDelivery ||= receipt?.hasPendingDelivery === true;
        return "settled";
      } finally {
        clearTimeout(timer);
      }
    },
    mayHaveDelivered,
    hasObservedDelivery: () => outcomes.has("delivered"),
    canAttemptFallback: () =>
      !mayHaveDelivered() && !pendingDelivery && !outcomes.has("recovery-owned"),
    hasPendingDelivery: () => pendingDelivery,
    resolveTerminalDelivery: () => terminalDelivery,
  };
}
