// Durable settlement for the follow-up drain.
//
// The drain decides what runs next; this module owns what happens to durable
// state once a turn settles: acknowledging it, tombstoning canceled, delivered,
// and discarded work, and capturing or restoring the summary queue around an
// overflow delivery. These helpers touch only SQLite persistence, the queue
// lifecycle, and the queue state shape, so they form a sibling module that the
// drain imports in one direction.
import { removeQueuedItemsByRef } from "../../../utils/queue-helpers.js";
import { createOverflowSummaryRetrySource } from "./delivery-context.js";
import { completeFollowupRunLifecycle } from "./lifecycle.js";
import { persistFollowupQueuesOrThrow } from "./persist.js";
import { consumeQueueSummaryDelivery } from "./summary-consumption.js";
import {
  isFollowupRunAborted,
  isFollowupTerminalDeliveryError,
  type FollowupRun,
} from "./types.js";

export async function persistDrainAcknowledgement(): Promise<void> {
  // Settle AFTER successful delivery (or fail-closed discard). Keep SQLite
  // rows until then so a crash mid-send can redeliver; OrThrow fails closed.
  // The write runs on the shared-state worker, so the caller must await it
  // before treating the turn as settled.
  await persistFollowupQueuesOrThrow();
}

function restoreRemovedFollowups(items: FollowupRun[], removed: readonly FollowupRun[]): void {
  for (const item of removed) {
    if (!items.includes(item)) {
      items.push(item);
    }
  }
}

export async function persistDrainAcknowledgementOrRestore(
  items: FollowupRun[],
  removed: readonly FollowupRun[],
): Promise<void> {
  try {
    await persistDrainAcknowledgement();
  } catch (error) {
    restoreRemovedFollowups(items, removed);
    throw error;
  }
}

export async function persistCanceledFollowupTombstones(
  canceled: readonly FollowupRun[],
): Promise<void> {
  for (const item of canceled) {
    item.canceled = true;
  }
  await persistDrainAcknowledgement();
}

export function isSettledFollowupTombstone(item: FollowupRun): boolean {
  return item.delivered === true || item.discarded === true;
}

export async function dropSettledFollowupTombstones(items: FollowupRun[]): Promise<number> {
  const settled = items.filter(isSettledFollowupTombstone);
  if (settled.length === 0) {
    return 0;
  }
  await persistDrainAcknowledgement();
  removeQueuedItemsByRef(items, settled);
  await persistDrainAcknowledgementOrRestore(items, settled);
  return settled.length;
}

async function persistQueueTombstones(
  queueItems: FollowupRun[],
  items: readonly FollowupRun[],
  flag: "delivered" | "discarded",
  reinsertMissing: boolean,
): Promise<void> {
  for (const item of items) {
    if (flag === "delivered") {
      item.delivered = true;
    } else {
      item.discarded = true;
    }
    // Only reinsert known queue identities that admission already removed.
    // Synthetic overflow/collect aggregate runs must not re-enter FIFO.
    if (reinsertMissing && !queueItems.includes(item)) {
      queueItems.push(item);
    }
  }
  // Keep the in-memory terminal marker even if this write throws. Rolling
  // it back would make already-executed work runnable again on restore.
  await persistDrainAcknowledgement();
}

export async function persistSuccessfulDeliveryReceipts(
  queueItems: FollowupRun[],
  items: readonly FollowupRun[],
  reinsertMissing = false,
): Promise<void> {
  await persistQueueTombstones(queueItems, items, "delivered", reinsertMissing);
}

async function persistFailedDeliveryDiscards(
  queueItems: FollowupRun[],
  items: readonly FollowupRun[],
  reinsertMissing = false,
): Promise<void> {
  await persistQueueTombstones(queueItems, items, "discarded", reinsertMissing);
}

function captureSummaryQueueState(queue: FollowupQueueSummaryState) {
  return {
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
  };
}

function restoreSummaryQueueState(
  queue: FollowupQueueSummaryState,
  snapshot: ReturnType<typeof captureSummaryQueueState>,
): void {
  queue.summarySources.splice(0, queue.summarySources.length, ...snapshot.summarySources);
  queue.summaryLines.splice(0, queue.summaryLines.length, ...snapshot.summaryLines);
  queue.summaryElisions.splice(0, queue.summaryElisions.length, ...snapshot.summaryElisions);
  queue.droppedCount = snapshot.droppedCount;
}

export async function consumeCanceledQueueSummarySources(
  queue: FollowupQueueSummaryState,
  canceled: readonly FollowupRun[],
): Promise<void> {
  await persistCanceledFollowupTombstones(canceled);
  const snapshot = captureSummaryQueueState(queue);
  try {
    consumeQueueSummaryDelivery(queue, {
      droppedCount: canceled.length,
      sources: [...canceled],
    });
    await persistDrainAcknowledgement();
  } catch (error) {
    restoreSummaryQueueState(queue, snapshot);
    throw error;
  }
}

export function removeCanceledFollowups(
  items: FollowupRun[],
  canceled: readonly FollowupRun[],
): void {
  removeQueuedItemsByRef(items, canceled);
  for (const item of canceled) {
    completeFollowupRunLifecycle(item);
  }
}

export type FollowupQueueSummaryState = {
  cap: number;
  inFlight: Set<FollowupRun>;
  droppedCount: number;
  summaryLines: string[];
  summarySources: FollowupRun[];
  activeSummarySources: WeakSet<FollowupRun>;
  summaryElisions: Array<{
    contextKey: string;
    count: number;
    sources: FollowupRun[];
    summaryLines: string[];
    sourceRefs: WeakMap<FollowupRun, FollowupRun>;
  }>;
  evictedSummaryCount: number;
};

export async function dropAbortedQueueSummarySources(
  queue: FollowupQueueSummaryState,
): Promise<number> {
  const aborted: FollowupRun[] = [];
  for (const source of queue.summarySources) {
    if (isFollowupRunAborted(source)) {
      aborted.push(source);
    }
  }
  for (const elision of queue.summaryElisions) {
    for (const source of elision.sources) {
      if (isFollowupRunAborted(source)) {
        aborted.push(source);
      }
    }
  }
  if (aborted.length === 0) {
    return 0;
  }
  await consumeCanceledQueueSummarySources(queue, aborted);
  return aborted.length;
}

export type QueueSummaryDelivery = {
  prompt: string;
  droppedCount: number;
  sources: FollowupRun[];
};

export function releaseQueueSummaryDeliveryForRetry(
  queue: FollowupQueueSummaryState,
  delivery: QueueSummaryDelivery,
): void {
  for (const source of delivery.sources) {
    const sourceIndex = queue.summarySources.indexOf(source);
    if (sourceIndex >= 0) {
      queue.summarySources[sourceIndex] = createOverflowSummaryRetrySource(source);
    }
    if (!source.turnAdoptionLifecycle) {
      completeFollowupRunLifecycle(source);
    }
  }
}

/**
 * Wrap the drain callback with durable settlement.
 *
 * The drain owns what runs next; settlement of the durable row belongs here.
 * A turn whose targets are already tombstoned only re-acknowledges, a terminal
 * delivery failure discards them fail-closed, and a successful run writes its
 * delivery receipts. The reserve options settle after a successful remove so
 * the row outlives the send that produced it.
 */
export function createDrainSettlementBinding(params: {
  queue: { items: FollowupRun[]; inFlight: Set<FollowupRun> };
  runFollowup: (item: FollowupRun) => Promise<void>;
  isCurrentQueueOwner: () => boolean;
}) {
  const runFollowupWithDeliveryReceipt = async (item: FollowupRun) => {
    // An overflow summary executes a synthetic run that is never serialized;
    // its settlement belongs to the queued sources the snapshot retains.
    const settlementTargets = item.overflowSummarySources ?? [item];
    if (settlementTargets.every(isSettledFollowupTombstone)) {
      // Execution already finished; a retry only settles durable state.
      await persistDrainAcknowledgement();
      return;
    }
    try {
      await params.runFollowup(item);
    } catch (error) {
      if (isFollowupTerminalDeliveryError(error)) {
        await persistFailedDeliveryDiscards(params.queue.items, settlementTargets);
        return;
      }
      throw error;
    }
    await persistSuccessfulDeliveryReceipts(params.queue.items, settlementTargets);
  };
  return {
    runFollowupWithDeliveryReceipt,
    reserveOptions: {
      inFlight: params.queue.inFlight,
      shouldRestoreOnError: params.isCurrentQueueOwner,
      onDiscard: (item: FollowupRun) => completeFollowupRunLifecycle(item),
      // Settle durable state after successful remove (or fail-closed discard).
      acknowledgeAfterSuccess: async () => {
        await persistDrainAcknowledgement();
      },
    },
  };
}

/**
 * Settle a failed group drain.
 *
 * Returns "continue" when the failure is terminal delivery: the group is
 * discarded fail-closed and the loop moves on. Otherwise durable state is
 * settled for the path the caller is on and the error is rethrown.
 */
export async function settleGroupDrainFailure(params: {
  error: unknown;
  queue: { items: FollowupRun[]; inFlight: Set<FollowupRun> };
  groupItems: FollowupRun[];
  admitted: boolean;
  isCurrentQueueOwner: () => boolean;
  completeGroup: () => void;
}): Promise<"continue" | "rethrow"> {
  if (isFollowupTerminalDeliveryError(params.error)) {
    await persistFailedDeliveryDiscards(params.queue.items, params.groupItems, true);
    params.completeGroup();
    await persistDrainAcknowledgement();
    return "continue";
  }
  if (params.admitted) {
    params.completeGroup();
  } else if (params.isCurrentQueueOwner()) {
    for (const item of params.groupItems) {
      params.queue.inFlight.delete(item);
    }
  } else {
    removeQueuedItemsByRef(params.queue.items, params.groupItems);
    for (const item of params.groupItems) {
      completeFollowupRunLifecycle(item);
    }
    await persistDrainAcknowledgement();
  }
  return "rethrow";
}

/**
 * Settle a group that was canceled before admission.
 *
 * Canceled sources are tombstoned before removal so restore cannot execute
 * them. Survivors stay queued while this process still owns the queue, and are
 * otherwise released with the durable row acknowledged.
 */
export async function settleCanceledGroupSources(params: {
  queue: { items: FollowupRun[] };
  groupItems: FollowupRun[];
  isCurrentQueueOwner: () => boolean;
  removeCanceledFollowups: (items: FollowupRun[], canceled: readonly FollowupRun[]) => void;
}): Promise<"break" | "continue" | "none"> {
  const canceledSources = params.groupItems.filter(isFollowupRunAborted);
  if (canceledSources.length === 0) {
    return "none";
  }
  await persistCanceledFollowupTombstones(canceledSources);
  params.removeCanceledFollowups(params.queue.items, canceledSources);
  const survivors = params.groupItems.filter((item) => !canceledSources.includes(item));
  if (params.isCurrentQueueOwner()) {
    await persistDrainAcknowledgementOrRestore(params.queue.items, canceledSources);
    return survivors.length > 0 ? "break" : "continue";
  }
  removeQueuedItemsByRef(params.queue.items, survivors);
  for (const item of survivors) {
    completeFollowupRunLifecycle(item);
  }
  await persistDrainAcknowledgementOrRestore(params.queue.items, [
    ...canceledSources,
    ...survivors,
  ]);
  return "continue";
}

/**
 * Settle a failed priority drain.
 *
 * The caller still owns rethrowing; this releases the in-flight mark and, when
 * the queue is no longer this process's to restore into, discards the item and
 * acknowledges the durable row so a restart cannot replay it.
 */
export async function settlePriorityDrainFailure(
  queue: { items: FollowupRun[]; inFlight: Set<FollowupRun> },
  priority: FollowupRun,
  options: { shouldRestoreOnError: () => boolean; onDiscard: (item: FollowupRun) => void },
): Promise<void> {
  queue.inFlight.delete(priority);
  if (options.shouldRestoreOnError()) {
    return;
  }
  removeQueuedItemsByRef(queue.items, [priority]);
  options.onDiscard(priority);
  await persistDrainAcknowledgement();
}
