import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeChatType } from "../../../channels/chat-type.js";
import { racePromiseWithAbortSignal } from "../../../infra/abort-signal.js";
import { logMessageQueuedWithBacklogPolicy } from "../../../logging/diagnostic-runtime.js";
import { channelRouteDedupeKey } from "../../../plugin-sdk/channel-route.js";
import { defaultRuntime } from "../../../runtime.js";
import { extractTextFromChatContent } from "../../../shared/chat-content.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  applyQueueDropPolicy,
  countPendingQueueItems,
  shouldSkipQueueItem,
} from "../../../utils/queue-helpers.js";
import {
  createOverflowSummaryRetrySource,
  resolveFollowupAuthorizationKey,
  resolveFollowupDeliveryContextKey,
} from "./delivery-context.js";
import {
  clearFollowupDrainCallback,
  dropAbortedFollowups,
  kickFollowupDrainIfIdle,
  rememberFollowupDrainCallback,
} from "./drain.js";
import {
  completeFollowupRunLifecycle,
  isFollowupRunPending,
  markFollowupRunEnqueued,
} from "./lifecycle.js";
import {
  peekRecentQueueMessageId,
  recordRecentQueueMessageId,
  resetRecentQueuedMessageIdDedupe,
} from "./recent-message-ids.js";
import {
  FOLLOWUP_QUEUES,
  getExistingFollowupQueue,
  getFollowupQueue,
  trimSummaryElisionsToCap,
} from "./state.js";
import {
  isFollowupRunAborted,
  resolveFollowupAbortSignal,
  type EnqueueFollowupRunOptions,
  type FollowupRun,
  type FollowupQueueDisposition,
  type QueueDedupeMode,
  type QueueSettings,
} from "./types.js";

function followupMessageRouteIdentityKey(run: FollowupRun): string {
  return JSON.stringify([
    channelRouteDedupeKey({
      channel: run.originatingChannel,
      to: run.originatingTo,
      accountId: run.originatingAccountId,
      threadId: run.originatingThreadId,
    }),
    normalizeChatType(run.originatingChatType) ?? "",
  ]);
}

function buildRecentMessageIdKey(run: FollowupRun, queueKey: string): string | undefined {
  const messageId = normalizeOptionalString(run.messageId);
  if (!messageId) {
    return undefined;
  }
  // Use JSON tuple serialization to avoid delimiter-collision edge cases when
  // channel/to/account values contain "|" characters.
  return JSON.stringify(["queue", queueKey, followupMessageRouteIdentityKey(run), messageId]);
}

function isRunAlreadyQueued(run: FollowupRun, items: FollowupRun[]): boolean {
  const messageId = normalizeOptionalString(run.messageId);
  if (messageId) {
    const messageRouteKey = followupMessageRouteIdentityKey(run);
    return items.some(
      (item) =>
        normalizeOptionalString(item.messageId) === messageId &&
        followupMessageRouteIdentityKey(item) === messageRouteKey,
    );
  }
  return false;
}

function appendQueueItem(params: {
  key: string;
  queue: ReturnType<typeof getFollowupQueue>;
  run: FollowupRun;
  recentMessageIdKey?: string;
  runFollowup?: (run: FollowupRun) => Promise<void>;
  restartIfIdle: boolean;
  front: boolean;
}): void {
  params.queue.lastEnqueuedAt = Date.now();
  params.queue.lastRun = params.run.run;
  params.run.queueAbortSignal = params.queue.abortController.signal;
  params.queue.items[params.front ? "unshift" : "push"](params.run);
  if (params.recentMessageIdKey) {
    recordRecentQueueMessageId(params.run, params.recentMessageIdKey);
  }
  const runFollowup = params.runFollowup;
  if (runFollowup) {
    rememberFollowupDrainCallback(params.key, runFollowup);
  }
  const signal = resolveFollowupAbortSignal({
    abortSignal: params.run.abortSignal,
    operatorAuthority: params.run.operatorAuthority,
  });
  const lifecycle = params.run.turnAdoptionLifecycle;
  if (signal && lifecycle && runFollowup) {
    const onAbort = () => {
      const queue = getExistingFollowupQueue(params.key);
      if (queue) {
        // Cancellation must release pending ownership even while normal draining is dormant.
        void dropAbortedFollowups(queue, runFollowup).catch((error: unknown) => {
          defaultRuntime.error?.(`followup queue cancellation failed: ${String(error)}`);
        });
      }
    };
    const onSettled = lifecycle.onSettled;
    lifecycle.onSettled = () => {
      signal.removeEventListener("abort", onAbort);
      onSettled?.();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  }
  if (params.restartIfIdle && !params.queue.draining) {
    kickFollowupDrainIfIdle(params.key);
  }
}

export function enqueueFollowupRun(
  key: string,
  run: FollowupRun,
  settings: QueueSettings,
  dedupeMode: QueueDedupeMode = "message-id",
  runFollowup?: (run: FollowupRun) => Promise<void>,
  restartIfIdle = true,
  options: EnqueueFollowupRunOptions = {},
): boolean {
  if (isFollowupRunAborted(run)) {
    return false;
  }
  if (options.position === "front") {
    run.protectFromQueueOverflow = true;
  }
  // Peek before getFollowupQueue: rejecting a redelivery after the original
  // queue drained and self-deleted must not recreate an empty registry entry,
  // which nothing would ever delete again.
  const recentMessageIdKey = dedupeMode !== "none" ? buildRecentMessageIdKey(run, key) : undefined;
  if (recentMessageIdKey && peekRecentQueueMessageId(recentMessageIdKey)) {
    return false;
  }
  const queue = getFollowupQueue(key, settings);

  const dedupe = dedupeMode === "none" ? undefined : isRunAlreadyQueued;

  if (shouldSkipQueueItem({ item: run, items: queue.items, dedupe })) {
    return false;
  }
  // Preserve later prompts while an older steer decides between same-turn
  // delivery and fallback; overflow resumes when the gate resolves.
  const deferOverflow = options.steerCandidate || queue.items.some((item) => item.steerPending);
  // drop:new rejects this source without mutating the existing queue. Do not
  // publish an external queued identity for work that will never be admitted.
  if (
    !deferOverflow &&
    queue.dropPolicy === "new" &&
    queue.cap > 0 &&
    countPendingQueueItems(queue.items, queue.inFlight) >= queue.cap
  ) {
    completeOverflowedFollowupRun(run, "queue-cap-new");
    return false;
  }
  if (!markFollowupRunEnqueued(run)) {
    return false;
  }
  if (deferOverflow) {
    if (options.steerCandidate) {
      reserveSteerAcceptance(queue, run);
    }
  } else if (!applyFollowupQueueOverflow(queue, run)) {
    return false;
  }
  appendQueueItem({
    key,
    queue,
    run,
    recentMessageIdKey,
    runFollowup,
    restartIfIdle,
    front: options.position === "front" && (!deferOverflow || options.steerCandidate === true),
  });
  return true;
}

function completeOverflowedFollowupRun(
  run: FollowupRun,
  disposition: FollowupQueueDisposition,
): void {
  try {
    try {
      run.onQueueDisposition?.(disposition);
    } finally {
      completeFollowupRunLifecycle(run);
    }
  } catch (error) {
    // Overflow already detached this source. A notification failure must not
    // strand its authority, the consumed steer, or the remaining FIFO siblings.
    defaultRuntime.error?.(`followup queue overflow settlement failed: ${String(error)}`);
  }
}

function applyFollowupQueueOverflow(
  queue: ReturnType<typeof getFollowupQueue>,
  run: FollowupRun,
): boolean {
  const elidedSummaryLines: string[] = [];
  const shouldEnqueue = applyQueueDropPolicy({
    queue,
    inFlight: queue.inFlight,
    summarize: (item) => {
      const approved = item.userTurnTranscriptRecorder?.getPendingInputMessage?.();
      // Capture the approved body before overflow stores its bounded preview.
      return approved
        ? (extractTextFromChatContent(approved.content, {
            normalizeText: (text) => text,
            joinWith: "\n",
          }) ?? "")
        : normalizeOptionalString(item.summaryLine) || item.prompt.trim();
    },
    onSummaryElide: (lines) => elidedSummaryLines.push(...lines),
    onDrop: (dropped) => {
      if (queue.dropPolicy === "summarize") {
        queue.summarySources.push(...dropped);
        return;
      }
      for (const item of dropped) {
        completeOverflowedFollowupRun(item, "queue-cap-old");
      }
    },
    isProtected: (item) => item.protectFromQueueOverflow === true,
  });
  if (queue.dropPolicy === "summarize") {
    const overflow = queue.summarySources.length - queue.summaryLines.length;
    if (overflow > 0) {
      const removed = queue.summarySources.splice(0, overflow);
      for (const [index, item] of removed.entries()) {
        const summaryLine = elidedSummaryLines[index];
        if (summaryLine === undefined) {
          throw new Error("followup queue summary source lost its elided line");
        }
        const contextKey = resolveFollowupDeliveryContextKey(item);
        const lastElision = queue.summaryElisions.at(-1);
        const compactSource = createOverflowSummaryRetrySource(item);
        if (lastElision?.contextKey === contextKey) {
          lastElision.sources.push(compactSource);
          lastElision.summaryLines.push(summaryLine);
          lastElision.sourceRefs.set(item, compactSource);
        } else {
          queue.summaryElisions.push({
            contextKey,
            sources: [compactSource],
            summaryLines: [summaryLine],
            sourceRefs: new WeakMap([[item, compactSource]]),
          });
        }
        if (queue.activeSummarySources.has(item)) {
          queue.activeSummarySources.add(compactSource);
        }
        trimSummaryElisionsToCap(queue);
      }
    }
  }
  if (!shouldEnqueue) {
    completeOverflowedFollowupRun(run, queue.dropPolicy === "new" ? "queue-cap-new" : "queue-cap");
    return false;
  }
  return true;
}

export function getFollowupQueueDepth(key: string): number {
  const queue = getExistingFollowupQueue(key);
  if (!queue) {
    return 0;
  }
  return countPendingQueueItems(queue.items, queue.inFlight);
}

/**
 * Claims the next pending user request when it comes from the same route and principal
 * as `source`, so it can answer for it; internal retries and ambient events do not count.
 * The claimed request survives overflow eviction like a front-queued recovery run.
 */
export function claimNextQueuedFollowupRequestFrom(
  key: string,
  source: FollowupRun,
): FollowupRun | undefined {
  const queue = getExistingFollowupQueue(key);
  const next = queue?.items.find(
    (item) =>
      !queue.inFlight.has(item) &&
      !isFollowupRunAborted(item) &&
      item.run.terminalReplyExpectation === "required" &&
      item.strandedReplyRetry !== true,
  );
  if (
    !next ||
    next.steerPending ||
    followupMessageRouteIdentityKey(next) !== followupMessageRouteIdentityKey(source) ||
    resolveFollowupAuthorizationKey(next) !== resolveFollowupAuthorizationKey(source)
  ) {
    return undefined;
  }
  next.protectFromQueueOverflow = true;
  return next;
}

function settleParkedSteerAcceptance(key: string, run: FollowupRun, accepted: boolean): boolean {
  const queue = getExistingFollowupQueue(key);
  const pending = run.steerPending;
  if (!queue?.items.includes(run) || !pending) {
    return false;
  }
  pending.settle(accepted);
  if (!accepted) {
    delete run.steerPending;
    reapplyDeferredOverflow(key);
    kickFollowupDrainIfIdle(key);
  }
  return true;
}

function reapplyDeferredOverflow(key: string): void {
  const queue = getExistingFollowupQueue(key);
  if (
    !queue ||
    queue.items.some((item) => item.steerPending) ||
    countPendingQueueItems(queue.items, queue.inFlight) <= queue.cap
  ) {
    return;
  }
  // These sources already belong to the queue; cap reconciliation must not
  // reacquire their admission or lose later input to a stale source's authority.
  const items = queue.items.splice(0);
  for (const item of items) {
    if (queue.inFlight.has(item) || applyFollowupQueueOverflow(queue, item)) {
      queue.items.push(item);
    }
  }
}

/** Remove an exactly committed steer while preserving every sibling's FIFO position. */
function consumeParkedFollowupRun(
  key: string,
  run: FollowupRun,
  disposition?: "consumed",
): boolean {
  const queue = getExistingFollowupQueue(key);
  const index = queue?.items.indexOf(run) ?? -1;
  if (!queue || index < 0) {
    return false;
  }
  queue.items.splice(index, 1);
  run.steerPending?.settle(true);
  delete run.steerPending;
  delete run.protectFromQueueOverflow;
  reapplyDeferredOverflow(key);
  completeFollowupRunLifecycle(run, disposition);
  if (
    !queue.draining &&
    queue.items.length === 0 &&
    queue.inFlight.size === 0 &&
    queue.droppedCount === 0 &&
    FOLLOWUP_QUEUES.get(key) === queue
  ) {
    FOLLOWUP_QUEUES.delete(key);
    clearFollowupDrainCallback(key);
  } else {
    kickFollowupDrainIfIdle(key);
  }
  return true;
}

export type ParkedSteerReservation = {
  assertCurrent: () => void;
  admit: () => Promise<"steer" | "fallback" | "cancelled">;
  accepted: (accepted: boolean) => void;
  fallback: () => void;
  consume: (disposition?: "consumed") => void;
};

export function parkSteerCandidate(
  key: string,
  run: FollowupRun,
  settings: QueueSettings,
  runFollowup: (run: FollowupRun) => Promise<void>,
): ParkedSteerReservation | undefined {
  if (
    !enqueueFollowupRun(key, run, settings, "message-id", runFollowup, false, {
      steerCandidate: true,
    })
  ) {
    return undefined;
  }
  logMessageQueuedWithBacklogPolicy(
    {
      sessionId: run.run.sessionId,
      sessionKey: key,
      channel: run.originatingChannel ?? run.run.messageProvider,
      source: "followup-queue-steer",
    },
    false,
  );
  return createParkedSteerReservation(key, run);
}

function reserveSteerAcceptance(
  queue: ReturnType<typeof getFollowupQueue>,
  run: FollowupRun,
): void {
  const { promise: acceptance, resolve: settle } = createDeferredCore<boolean>();
  run.steerPending = { phase: "waiting", predecessor: queue.steerAcceptanceTail, settle };
  // Canceled waiters must not release successors before their own predecessors.
  queue.steerAcceptanceTail = queue.steerAcceptanceTail.then(() => acceptance);
}

/** Reserve existing custody without enqueueing, readmitting, or changing FIFO position. */
export function reserveQueuedSteerCandidate(
  key: string,
  run: FollowupRun,
): ParkedSteerReservation | undefined {
  const queue = getExistingFollowupQueue(key);
  if (
    !queue?.items.includes(run) ||
    queue.inFlight.has(run) ||
    queue.activeSummarySources.has(run) ||
    run.steerPending ||
    isFollowupRunAborted(run) ||
    !isFollowupRunPending(run)
  ) {
    return undefined;
  }
  run.operatorAuthority?.assertCurrent();
  reserveSteerAcceptance(queue, run);
  return createParkedSteerReservation(key, run);
}

function createParkedSteerReservation(key: string, run: FollowupRun): ParkedSteerReservation {
  const queue = getExistingFollowupQueue(key);
  const pending = run.steerPending;
  // Recovery may transfer this exact source and reservation into a replacement
  // drain. It revokes injection, but the original attempt must still settle custody.
  const ownsSourceReservation = () =>
    getExistingFollowupQueue(key)?.items.includes(run) === true && run.steerPending === pending;
  const ownsReservation = () => getExistingFollowupQueue(key) === queue && ownsSourceReservation();
  return {
    assertCurrent() {
      if (!ownsReservation() || isFollowupRunAborted(run)) {
        throw new Error("Queued steering source is no longer current");
      }
      run.operatorAuthority?.assertCurrent();
    },
    async admit() {
      await racePromiseWithAbortSignal(
        pending?.predecessor ?? Promise.resolve(true),
        resolveFollowupAbortSignal(run),
      ).catch((error: unknown) => {
        if (isFollowupRunAborted(run) || !ownsReservation()) {
          return false;
        }
        throw error;
      });
      if (isFollowupRunAborted(run) || !ownsSourceReservation()) {
        return "cancelled";
      }
      if (!ownsReservation() || !pending) {
        // A recovered source stays queued; only its old injection authority ended.
        return "fallback";
      }
      // The injection owner now decides whether this input can safely be replayed.
      pending.phase = "injecting";
      return "steer";
    },
    accepted: (accepted) => {
      if (ownsSourceReservation()) {
        settleParkedSteerAcceptance(key, run, accepted);
      }
    },
    fallback: () => {
      if (ownsSourceReservation()) {
        settleParkedSteerAcceptance(key, run, false);
      }
    },
    consume: (disposition) => {
      if (ownsSourceReservation()) {
        consumeParkedFollowupRun(key, run, disposition);
      }
    },
  };
}

if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.queueEnqueueTestApi")] = {
    resetRecentQueuedMessageIdDedupe,
  };
}
