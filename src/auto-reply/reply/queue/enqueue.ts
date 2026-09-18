// Enqueues follow-up reply runs and schedules queue drains.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeChatType } from "../../../channels/chat-type.js";
import { racePromiseWithAbortSignal } from "../../../infra/abort-signal.js";
import { logMessageQueuedWithBacklogPolicy } from "../../../logging/diagnostic-runtime.js";
import { channelRouteDedupeKey } from "../../../plugin-sdk/channel-route.js";
import { defaultRuntime } from "../../../runtime.js";
import { extractTextFromChatContent } from "../../../shared/chat-content.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { isIncognitoSessionKey } from "../../../shared/incognito-session-key.js";
import {
  applyQueueDropPolicy,
  countPendingQueueItems,
  shouldSkipQueueItem,
} from "../../../utils/queue-helpers.js";
import {
  createOverflowSummaryRetrySource,
  resolveFollowupDeliveryContextKey,
} from "./delivery-context.js";
import {
  clearFollowupDrainCallback,
  dropAbortedFollowups,
  kickFollowupDrainIfIdle,
  rememberFollowupDrainCallback,
} from "./drain.js";
import { completeFollowupRunLifecycle, markFollowupRunEnqueued } from "./lifecycle.js";
import { isOutsideDurableQueueCustody } from "./persist-codec.js";
import { isIncognitoFollowupQueue } from "./persist-snapshot-policy.js";
import { persistFollowupQueues, persistFollowupQueuesOrThrow } from "./persist.js";
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
  type FollowupQueueState,
  type FollowupRun,
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
  queue: Awaited<ReturnType<typeof getFollowupQueue>>;
  run: FollowupRun;
  recentMessageIdKey?: string;
  runFollowup?: (run: FollowupRun) => Promise<void>;
  restartIfIdle: boolean;
  front: boolean;
}): { releaseRecentMessageId: (() => void) | undefined } {
  params.queue.lastEnqueuedAt = Date.now();
  params.queue.lastRun = params.run.run;
  params.run.queueAbortSignal = params.queue.abortController.signal;
  params.queue.items[params.front ? "unshift" : "push"](params.run);
  const releaseRecentMessageId = params.recentMessageIdKey
    ? recordRecentQueueMessageId(params.run, params.recentMessageIdKey)
    : undefined;
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
  return { releaseRecentMessageId };
}

function captureQueueMutationState(queue: FollowupQueueState) {
  return {
    items: queue.items.slice(),
    summarySources: queue.summarySources.slice(),
    summaryLines: queue.summaryLines.slice(),
    summaryElisions: queue.summaryElisions.map((elision) => ({
      contextKey: elision.contextKey,
      count: elision.count,
      sources: elision.sources.slice(),
      summaryLines: elision.summaryLines.slice(),
      sourceRefs: elision.sourceRefs,
    })),
    droppedCount: queue.droppedCount,
    lastEnqueuedAt: queue.lastEnqueuedAt,
    lastRun: queue.lastRun,
    evictedSummaryCount: queue.evictedSummaryCount,
    cap: queue.cap,
  };
}

function restoreQueueMutationState(
  queue: FollowupQueueState,
  snapshot: ReturnType<typeof captureQueueMutationState>,
): void {
  queue.items.splice(0, queue.items.length, ...snapshot.items);
  queue.summarySources.splice(0, queue.summarySources.length, ...snapshot.summarySources);
  queue.summaryLines.splice(0, queue.summaryLines.length, ...snapshot.summaryLines);
  queue.summaryElisions.splice(0, queue.summaryElisions.length, ...snapshot.summaryElisions);
  queue.droppedCount = snapshot.droppedCount;
  queue.lastEnqueuedAt = snapshot.lastEnqueuedAt;
  queue.lastRun = snapshot.lastRun;
  queue.evictedSummaryCount = snapshot.evictedSummaryCount;
  queue.cap = snapshot.cap;
}

function completeDeferredDrops(drops: readonly FollowupRun[]): void {
  for (const dropped of drops) {
    completeFollowupRunLifecycle(dropped);
  }
}

function rollbackFailedDurableAdmission(params: {
  key: string;
  run: FollowupRun;
  restore: () => void;
  releaseRecentMessageId?: () => void;
  err: unknown;
}): false {
  params.restore();
  defaultRuntime.error?.(
    `rejected followup enqueue for ${params.key}: persistence failed: ${String(params.err)}`,
  );
  // Failed durable admission never delivered. Release the exact message-id
  // reservation first: runs without a turnAdoptionLifecycle have no abandonment
  // hook, so lifecycle completion alone would leave the retry suppressed.
  params.releaseRecentMessageId?.();
  completeFollowupRunLifecycle(params.run);
  return false;
}

async function appendQueueItemWithPersist(
  params: Parameters<typeof appendQueueItem>[0],
): Promise<boolean> {
  const itemsSnapshot = params.queue.items.slice();
  const lastEnqueuedAtSnapshot = params.queue.lastEnqueuedAt;
  const lastRunSnapshot = params.queue.lastRun;
  const { releaseRecentMessageId } = appendQueueItem(params);
  try {
    if (
      isOutsideDurableQueueCustody(params.run) ||
      isIncognitoFollowupQueue(params.key, params.queue)
    ) {
      // Never written by this owner, so admission must not depend on shared
      // SQLite being reachable. Other keys may still owe a row, so the write is
      // attempted best-effort rather than skipped.
      await persistFollowupQueues();
    } else {
      await persistFollowupQueuesOrThrow();
    }
    bindDurableCancellation(params.run);
    return true;
  } catch (err) {
    return rollbackFailedDurableAdmission({
      key: params.key,
      run: params.run,
      releaseRecentMessageId,
      restore: () => {
        params.queue.items.length = 0;
        params.queue.items.push(...itemsSnapshot);
        params.queue.lastEnqueuedAt = lastEnqueuedAtSnapshot;
        params.queue.lastRun = lastRunSnapshot;
      },
      err,
    });
  }
}

function bindDurableCancellation(run: FollowupRun): void {
  const lifecycle = run.turnAdoptionLifecycle;
  if (!lifecycle) {
    return;
  }
  lifecycle.onCancellationRequested = async () => {
    let found = false;
    for (const queue of FOLLOWUP_QUEUES.values()) {
      const sources = [
        ...queue.items,
        ...queue.inFlight,
        ...queue.summarySources,
        ...queue.summaryElisions.flatMap((entry) => entry.sources),
      ];
      for (const source of sources) {
        if (source.turnAdoptionLifecycle === lifecycle) {
          source.canceled = true;
          found = true;
        }
      }
    }
    if (!found) {
      throw new Error("queued followup cancellation owner is no longer durable");
    }
    await persistFollowupQueuesOrThrow();
  };
}

export async function enqueueFollowupRun(
  key: string,
  run: FollowupRun,
  settings: QueueSettings,
  dedupeMode: QueueDedupeMode = "message-id",
  runFollowup?: (run: FollowupRun) => Promise<void>,
  restartIfIdle = true,
  options: EnqueueFollowupRunOptions = {},
): Promise<boolean> {
  if (isFollowupRunAborted(run)) {
    return false;
  }
  if (options.position === "front") {
    run.protectFromQueueOverflow = true;
  }
  if (options.steerCandidate) {
    run.steerAnchor = true;
  }
  // Peek before getFollowupQueue: rejecting a redelivery after the original
  // queue drained and self-deleted must not recreate an empty registry entry,
  // which nothing would ever delete again.
  const recentMessageIdKey = dedupeMode !== "none" ? buildRecentMessageIdKey(run, key) : undefined;
  if (recentMessageIdKey && peekRecentQueueMessageId(recentMessageIdKey)) {
    return false;
  }
  let queue: Awaited<ReturnType<typeof getFollowupQueue>>;
  try {
    // Work this owner never writes must not depend on the durable row being
    // readable — including on first use, where materializing the queue is what
    // reads it. Incognito is decided by the key here because the queue does not
    // exist yet to classify by its runs.
    const memoryOnly = isOutsideDurableQueueCustody(run) || isIncognitoSessionKey(key);
    queue = await getFollowupQueue(key, settings, memoryOnly ? { memoryOnly: true } : undefined);
  } catch (err) {
    // The key's durable row could not be reconciled, so this turn cannot be made
    // durable. Reject it like a failed durable admission instead of accepting work
    // a restart would lose; completing the lifecycle hands an ingress claim back.
    defaultRuntime.error?.(`rejected followup enqueue for ${key}: ${String(err)}`);
    completeFollowupRunLifecycle(run);
    return false;
  }

  const dedupe = dedupeMode === "none" ? undefined : isRunAlreadyQueued;

  // Deduplicate: skip if the same message is already queued.
  if (shouldSkipQueueItem({ item: run, items: queue.items, dedupe })) {
    return false;
  }
  // Preserve later prompts while an older steer decides between same-turn
  // delivery and fallback; overflow resumes when the gate resolves.
  if (options.steerCandidate || queue.items.some((item) => item.steerPending)) {
    if (!markFollowupRunEnqueued(run)) {
      return false;
    }
    // Only a steer candidate opens an acceptance gate; a later prompt merely
    // queues behind the anchor. Both go through durable admission, so both can
    // be rolled back together when the durable write fails.
    let previousAcceptanceTail: typeof queue.steerAcceptanceTail | undefined;
    if (options.steerCandidate) {
      const { promise: acceptance, resolve: settle } = createDeferredCore<boolean>();
      previousAcceptanceTail = queue.steerAcceptanceTail;
      run.steerPending = { phase: "waiting", predecessor: previousAcceptanceTail, settle };
      queue.steerAcceptanceTail = acceptance;
    }
    if (
      !(await appendQueueItemWithPersist({
        key,
        queue,
        run,
        recentMessageIdKey,
        runFollowup,
        restartIfIdle,
        front: options.steerCandidate === true && options.position === "front",
      }))
    ) {
      if (previousAcceptanceTail !== undefined) {
        queue.steerAcceptanceTail = previousAcceptanceTail;
        delete run.steerPending;
      }
      return false;
    }
    return true;
  }
  // drop:new rejects this source without mutating the existing queue. Do not
  // publish an external queued identity for work that will never be admitted.
  const pendingCount = countPendingQueueItems(queue.items, queue.inFlight);
  if (queue.dropPolicy === "new" && queue.cap > 0 && pendingCount >= queue.cap) {
    run.onQueueDisposition?.("queue-cap-new");
    if (options.deferPersist === true) {
      options.collectDeferredDrops?.push(run);
    } else {
      completeFollowupRunLifecycle(run);
    }
    return false;
  }
  if (!markFollowupRunEnqueued(run)) {
    return false;
  }

  // Snapshot before overflow mutations so a failed durable admit can restore
  // pre-existing queue work instead of permanently dropping/summarizing it.
  const admissionSnapshot = captureQueueMutationState(queue);
  const restoreAdmissionSnapshot = () => restoreQueueMutationState(queue, admissionSnapshot);
  const deferredOverflowDrops: FollowupRun[] = [];

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
        item.onQueueDisposition?.("queue-cap-old");
        // Defer lifecycle completion until durable admit succeeds.
        deferredOverflowDrops.push(item);
      }
    },
    isProtected: (item) => item.protectFromQueueOverflow === true || item.steerAnchor === true,
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
          lastElision.count += 1;
          lastElision.sources.push(compactSource);
          lastElision.summaryLines.push(summaryLine);
          lastElision.sourceRefs.set(item, compactSource);
        } else {
          queue.summaryElisions.push({
            contextKey,
            count: 1,
            sources: [compactSource],
            summaryLines: [summaryLine],
            sourceRefs: new WeakMap([[item, compactSource]]),
          });
        }
        if (queue.activeSummarySources.has(item)) {
          queue.activeSummarySources.add(compactSource);
        }
        // Defer irreversible lifecycle completion until SQLite admission succeeds;
        // a failed write must restore summarized sources as live queued work.
        deferredOverflowDrops.push(
          ...trimSummaryElisionsToCap(queue, { deferLifecycleCompletion: true }),
        );
      }
    }
  }
  if (!shouldEnqueue) {
    restoreAdmissionSnapshot();
    run.onQueueDisposition?.("queue-cap");
    if (options.deferPersist === true) {
      options.collectDeferredDrops?.push(run);
    } else {
      completeFollowupRunLifecycle(run);
    }
    return false;
  }
  const { releaseRecentMessageId } = appendQueueItem({
    key,
    queue,
    run,
    recentMessageIdKey,
    runFollowup,
    restartIfIdle,
    front: options.position === "front",
  });
  if (options.deferPersist !== true) {
    try {
      if (isOutsideDurableQueueCustody(run) || isIncognitoFollowupQueue(key, queue)) {
        // This run is never written, so its admission must not depend on shared
        // SQLite being reachable. Other keys may still owe a snapshot, so the
        // write is attempted best-effort rather than skipped outright.
        await persistFollowupQueues();
      } else {
        await persistFollowupQueuesOrThrow();
      }
    } catch (err) {
      return rollbackFailedDurableAdmission({
        key,
        run,
        releaseRecentMessageId,
        restore: restoreAdmissionSnapshot,
        err,
      });
    }
    bindDurableCancellation(run);
    completeDeferredDrops(deferredOverflowDrops);
  } else {
    options.collectDeferredDrops?.push(...deferredOverflowDrops);
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

async function settleParkedSteerAcceptance(
  key: string,
  run: FollowupRun,
  accepted: boolean,
): Promise<boolean> {
  const queue = getExistingFollowupQueue(key);
  const pending = run.steerPending;
  if (!queue?.items.includes(run) || !pending) {
    return false;
  }
  pending.settle(accepted);
  if (!accepted) {
    delete run.steerPending;
    await reapplyDeferredOverflow(key);
    kickFollowupDrainIfIdle(key);
  }
  return true;
}

function isParkedFollowupRunOwned(key: string, run: FollowupRun): boolean {
  return getExistingFollowupQueue(key)?.items.includes(run) === true;
}

async function reapplyDeferredOverflow(key: string): Promise<void> {
  const queue = getExistingFollowupQueue(key);
  if (!queue || queue.items.some((item) => item.steerPending)) {
    return;
  }
  const lastAnchor = queue.items.findLastIndex((item) => item.steerAnchor === true);
  const suffix = queue.items.slice(lastAnchor + 1);
  if (suffix.length === 0) {
    return;
  }
  const mutationSnapshot = captureQueueMutationState(queue);
  const deferredDrops: FollowupRun[] = [];
  queue.items.splice(lastAnchor + 1);
  const originalCap = queue.cap;
  const settings: QueueSettings = {
    mode: queue.mode,
    debounceMs: queue.debounceMs,
    cap: originalCap + lastAnchor + 1,
    dropPolicy: queue.dropPolicy,
  };
  for (const item of suffix) {
    if (
      !(await enqueueFollowupRun(key, item, settings, "none", undefined, false, {
        deferPersist: true,
        collectDeferredDrops: deferredDrops,
      })) &&
      !deferredDrops.includes(item)
    ) {
      deferredDrops.push(item);
    }
  }
  queue.cap = originalCap;
  try {
    await persistFollowupQueuesOrThrow();
  } catch (err) {
    restoreQueueMutationState(queue, mutationSnapshot);
    defaultRuntime.error?.(
      `failed to persist followup queue after deferred overflow for ${key}: ${String(err)}`,
    );
    return;
  }
  completeDeferredDrops(deferredDrops);
}

/** Remove an exactly committed steer while preserving every sibling's FIFO position. */
async function consumeParkedFollowupRun(
  key: string,
  run: FollowupRun,
  disposition?: "consumed",
): Promise<boolean> {
  const queue = getExistingFollowupQueue(key);
  const index = queue?.items.indexOf(run) ?? -1;
  if (!queue || index < 0) {
    return false;
  }
  queue.items.splice(index, 1);
  try {
    await persistFollowupQueuesOrThrow();
  } catch (err) {
    queue.items.splice(index, 0, run);
    defaultRuntime.error?.(
      `rejected parked-steer consume for ${key}: persistence failed: ${String(err)}`,
    );
    return false;
  }
  run.steerPending?.settle(true);
  delete run.steerPending;
  delete run.protectFromQueueOverflow;
  delete run.steerAnchor;
  await reapplyDeferredOverflow(key);
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

type ParkedSteerReservation = {
  admit: () => Promise<"steer" | "fallback" | "cancelled">;
  // Settlement writes the durable row through the shared-state worker.
  accepted: (accepted: boolean) => Promise<void>;
  fallback: () => Promise<void>;
  consume: (disposition?: "consumed") => Promise<void>;
};

export async function parkSteerCandidate(
  key: string,
  run: FollowupRun,
  settings: QueueSettings,
  runFollowup: (run: FollowupRun) => Promise<void>,
): Promise<ParkedSteerReservation | undefined> {
  if (
    !(await enqueueFollowupRun(key, run, settings, "message-id", runFollowup, false, {
      steerCandidate: true,
    }))
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
  return {
    async admit() {
      const pending = run.steerPending;
      const predecessorAccepted = await racePromiseWithAbortSignal(
        pending?.predecessor ?? Promise.resolve(true),
        resolveFollowupAbortSignal(run),
      ).catch((error: unknown) => {
        if (isFollowupRunAborted(run)) {
          return false;
        }
        throw error;
      });
      if (isFollowupRunAborted(run) || !isParkedFollowupRunOwned(key, run)) {
        return "cancelled";
      }
      if (!predecessorAccepted || !pending || run.steerPending !== pending) {
        return "fallback";
      }
      // The injection owner now decides whether this input can safely be replayed.
      pending.phase = "injecting";
      return "steer";
    },
    accepted: async (accepted) => {
      await settleParkedSteerAcceptance(key, run, accepted);
    },
    fallback: async () => {
      await settleParkedSteerAcceptance(key, run, false);
    },
    consume: async (disposition) => {
      await consumeParkedFollowupRun(key, run, disposition);
    },
  };
}

if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.queueEnqueueTestApi")] = {
    resetRecentQueuedMessageIdDedupe,
  };
}
