import { createDedupeCache } from "../../../infra/dedupe.js";
import { resolveGlobalSingleton } from "../../../shared/global-singleton.js";
import { applyQueueDropPolicy, shouldSkipQueueItem } from "../../../utils/queue-helpers.js";
import { kickFollowupDrainIfIdle } from "./drain.js";
import { getExistingFollowupQueue, getFollowupQueue } from "./state.js";
import type { FollowupRun, QueueDedupeMode, QueueSettings } from "./types.js";

/**
 * Keep queued message-id dedupe shared across bundled chunks so redeliveries
 * are rejected no matter which chunk receives the enqueue call.
 */
const RECENT_QUEUE_MESSAGE_IDS_KEY = Symbol.for("openclaw.recentQueueMessageIds");

const RECENT_QUEUE_MESSAGE_IDS = resolveGlobalSingleton(RECENT_QUEUE_MESSAGE_IDS_KEY, () =>
  createDedupeCache({
    ttlMs: 5 * 60 * 1000,
    maxSize: 10_000,
  }),
);

/**
 * TTL for the delivered-message dedupe cache.  Once a queued message has been
 * drained and handed to the agent, its ID is held here so that a subsequent
 * re-delivery of the same provider message is silently dropped instead of
 * being re-enqueued.  ~20 minutes mirrors the inbound dedupe window used in
 * inbound-dedupe.ts.
 */
export const DELIVERED_DEDUPE_TTL_MS = 20 * 60_000;

/**
 * Tracks message IDs that have already been delivered (drained from the queue).
 * Without this, a message whose enqueue-time cache entry has expired can bypass
 * `isRunAlreadyQueued` after `queue.items.splice` removes the delivered item,
 * causing the same message to be processed multiple times across drain cycles.
 */
const DELIVERED_QUEUE_MESSAGE_IDS_KEY = Symbol.for("openclaw.deliveredQueueMessageIds");

const DELIVERED_QUEUE_MESSAGE_IDS = resolveGlobalSingleton(DELIVERED_QUEUE_MESSAGE_IDS_KEY, () =>
  createDedupeCache({
    ttlMs: DELIVERED_DEDUPE_TTL_MS,
    maxSize: 10_000,
  }),
);

function buildRecentMessageIdKey(run: FollowupRun, queueKey: string): string | undefined {
  const messageId = run.messageId?.trim();
  if (!messageId) {
    return undefined;
  }
  // Use JSON tuple serialization to avoid delimiter-collision edge cases when
  // channel/to/account values contain "|" characters.
  return JSON.stringify([
    "queue",
    queueKey,
    run.originatingChannel ?? "",
    run.originatingTo ?? "",
    run.originatingAccountId ?? "",
    run.originatingThreadId == null ? "" : String(run.originatingThreadId),
    messageId,
  ]);
}

function isRunAlreadyQueued(
  run: FollowupRun,
  items: FollowupRun[],
  allowPromptFallback = false,
): boolean {
  const hasSameRouting = (item: FollowupRun) =>
    item.originatingChannel === run.originatingChannel &&
    item.originatingTo === run.originatingTo &&
    item.originatingAccountId === run.originatingAccountId &&
    item.originatingThreadId === run.originatingThreadId;

  const messageId = run.messageId?.trim();
  if (messageId) {
    return items.some((item) => item.messageId?.trim() === messageId && hasSameRouting(item));
  }
  if (!allowPromptFallback) {
    return false;
  }
  return items.some((item) => item.prompt === run.prompt && hasSameRouting(item));
}

export function enqueueFollowupRun(
  key: string,
  run: FollowupRun,
  settings: QueueSettings,
  dedupeMode: QueueDedupeMode = "message-id",
): boolean {
  const queue = getFollowupQueue(key, settings);
  const recentMessageIdKey = dedupeMode !== "none" ? buildRecentMessageIdKey(run, key) : undefined;
  if (recentMessageIdKey && RECENT_QUEUE_MESSAGE_IDS.peek(recentMessageIdKey)) {
    return false;
  }

  // Reject messages that were already delivered in a previous drain cycle.
  if (recentMessageIdKey && DELIVERED_QUEUE_MESSAGE_IDS.peek(recentMessageIdKey)) {
    return false;
  }

  const dedupe =
    dedupeMode === "none"
      ? undefined
      : (item: FollowupRun, items: FollowupRun[]) =>
          isRunAlreadyQueued(item, items, dedupeMode === "prompt");

  // Deduplicate: skip if the same message is already queued.
  if (shouldSkipQueueItem({ item: run, items: queue.items, dedupe })) {
    return false;
  }

  queue.lastEnqueuedAt = Date.now();
  queue.lastRun = run.run;

  const shouldEnqueue = applyQueueDropPolicy({
    queue,
    summarize: (item) => item.summaryLine?.trim() || item.prompt.trim(),
  });
  if (!shouldEnqueue) {
    return false;
  }

  queue.items.push(run);
  if (recentMessageIdKey) {
    RECENT_QUEUE_MESSAGE_IDS.check(recentMessageIdKey);
  }
  // If drain finished and deleted the queue before this item arrived, a new queue
  // object was created (draining: false) but nobody scheduled a drain for it.
  // Use the cached callback to restart the drain now.
  if (!queue.draining) {
    kickFollowupDrainIfIdle(key);
  }
  return true;
}

export function getFollowupQueueDepth(key: string): number {
  const queue = getExistingFollowupQueue(key);
  if (!queue) {
    return 0;
  }
  return queue.items.length;
}

/**
 * Record a batch of drained followup runs so that re-delivery of the same
 * provider messages is rejected for the duration of the delivered-dedupe TTL
 * window.  Call this from the drain loop after items are spliced out of the
 * queue.
 */
export function markFollowupRunsDelivered(runs: FollowupRun[], queueKey: string): void {
  for (const run of runs) {
    const cacheKey = buildRecentMessageIdKey(run, queueKey);
    if (cacheKey) {
      DELIVERED_QUEUE_MESSAGE_IDS.check(cacheKey);
    }
  }
}

export function resetRecentQueuedMessageIdDedupe(): void {
  RECENT_QUEUE_MESSAGE_IDS.clear();
  DELIVERED_QUEUE_MESSAGE_IDS.clear();
}
