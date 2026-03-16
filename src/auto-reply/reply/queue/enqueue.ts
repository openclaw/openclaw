import type { FollowupRun, QueueDedupeMode, QueueSettings } from "./types.js";
import { applyQueueDropPolicy, shouldSkipQueueItem } from "../../../utils/queue-helpers.js";
import { FOLLOWUP_QUEUES, getFollowupQueue } from "./state.js";

const RECENT_QUEUE_MESSAGE_ID_TTL_MS = 5 * 60 * 1000;
const RECENT_QUEUE_MESSAGE_ID_MAX = 10_000;
const recentQueueMessageIds = new Map<string, number>();

function normalizeMessageId(messageId: string | undefined): string | undefined {
  const trimmed = messageId?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.replace(/:permission-error$/i, "");
}

function buildRecentMessageIdKey(run: FollowupRun, queueKey: string): string | undefined {
  const messageId = normalizeMessageId(run.messageId);
  if (!messageId) {
    return undefined;
  }
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

function pruneRecentQueueMessageIds(now: number): void {
  const cutoff = now - RECENT_QUEUE_MESSAGE_ID_TTL_MS;
  for (const [key, ts] of recentQueueMessageIds) {
    if (ts < cutoff) {
      recentQueueMessageIds.delete(key);
    }
  }
  while (recentQueueMessageIds.size > RECENT_QUEUE_MESSAGE_ID_MAX) {
    const oldestKey = recentQueueMessageIds.keys().next().value;
    if (!oldestKey) {
      break;
    }
    recentQueueMessageIds.delete(oldestKey);
  }
}

function hasRecentQueuedMessageId(key: string | undefined, now = Date.now()): boolean {
  if (!key) {
    return false;
  }
  pruneRecentQueueMessageIds(now);
  const existing = recentQueueMessageIds.get(key);
  if (existing === undefined) {
    return false;
  }
  if (now - existing >= RECENT_QUEUE_MESSAGE_ID_TTL_MS) {
    recentQueueMessageIds.delete(key);
    return false;
  }
  return true;
}

function recordRecentQueuedMessageId(key: string | undefined, now = Date.now()): void {
  if (!key) {
    return;
  }
  recentQueueMessageIds.delete(key);
  recentQueueMessageIds.set(key, now);
  pruneRecentQueueMessageIds(now);
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

  const messageId = normalizeMessageId(run.messageId);
  if (messageId) {
    return items.some(
      (item) => normalizeMessageId(item.messageId) === messageId && hasSameRouting(item),
    );
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
  if (hasRecentQueuedMessageId(recentMessageIdKey)) {
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
  recordRecentQueuedMessageId(recentMessageIdKey);
  return true;
}

export function getFollowupQueueDepth(key: string): number {
  const cleaned = key.trim();
  if (!cleaned) {
    return 0;
  }
  const queue = FOLLOWUP_QUEUES.get(cleaned);
  if (!queue) {
    return 0;
  }
  return queue.items.length;
}

export function resetRecentQueuedMessageIdDedupe(): void {
  recentQueueMessageIds.clear();
}
