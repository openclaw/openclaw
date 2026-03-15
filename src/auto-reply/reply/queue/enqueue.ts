import { createDedupeCache } from "../../../infra/dedupe.js";
import { resolveGlobalSingleton } from "../../../shared/global-singleton.js";
import { buildQueueSummaryLine, shouldSkipQueueItem } from "../../../utils/queue-helpers.js";
import { kickFollowupDrainIfIdle } from "./drain.js";
import { getExistingFollowupQueue, getFollowupQueue, type FollowupQueueState } from "./state.js";
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

function applyFollowupQueueDropPolicy(queue: FollowupQueueState): boolean {
  const cap = queue.cap;
  if (cap <= 0 || queue.items.length < cap) {
    return true;
  }
  if (queue.dropPolicy === "new") {
    return false;
  }

  const dropCount = queue.items.length - cap + 1;
  const dropped = queue.items.splice(0, dropCount);
  if (queue.dropPolicy === "summarize") {
    for (const item of dropped) {
      queue.droppedCount += 1;
      queue.summaryItems.push(item);
      queue.summaryLines.push(
        buildQueueSummaryLine(item.summaryLine?.trim() || item.prompt.trim()),
      );
    }
    const limit = Math.max(0, cap);
    while (queue.summaryLines.length > limit) {
      queue.summaryLines.shift();
      queue.summaryItems.shift();
    }
  }
  return true;
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

  const shouldEnqueue = applyFollowupQueueDropPolicy(queue);
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

export function resetRecentQueuedMessageIdDedupe(): void {
  RECENT_QUEUE_MESSAGE_IDS.clear();
}
