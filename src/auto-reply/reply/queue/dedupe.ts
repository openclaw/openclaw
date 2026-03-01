import { createDedupeCache } from "../../../infra/dedupe.js";
import type { FollowupRun } from "./types.js";

const DELIVERED_FOLLOWUP_DEDUPE_TTL_MS = 20 * 60_000;
const DELIVERED_FOLLOWUP_DEDUPE_MAX = 5000;

const deliveredFollowupCache = createDedupeCache({
  ttlMs: DELIVERED_FOLLOWUP_DEDUPE_TTL_MS,
  maxSize: DELIVERED_FOLLOWUP_DEDUPE_MAX,
});

function buildDeliveredFollowupDedupeKey(queueKey: string, run: FollowupRun): string | null {
  const cleanedQueueKey = queueKey.trim();
  const messageId = run.messageId?.trim();
  if (!cleanedQueueKey || !messageId) {
    return null;
  }

  const channel = run.originatingChannel?.trim().toLowerCase() ?? "";
  const to = run.originatingTo?.trim() ?? "";
  const accountId = run.originatingAccountId?.trim() ?? "";
  const threadId =
    run.originatingThreadId !== undefined && run.originatingThreadId !== null
      ? String(run.originatingThreadId).trim()
      : "";

  return [cleanedQueueKey, channel, to, accountId, threadId, messageId]
    .filter((segment) => segment.length > 0)
    .join("|");
}

export function wasDeliveredFollowupRun(queueKey: string, run: FollowupRun, now?: number): boolean {
  const key = buildDeliveredFollowupDedupeKey(queueKey, run);
  if (!key) {
    return false;
  }
  return deliveredFollowupCache.peek(key, now);
}

export function markDeliveredFollowupRun(queueKey: string, run: FollowupRun, now?: number): void {
  const key = buildDeliveredFollowupDedupeKey(queueKey, run);
  if (!key) {
    return;
  }
  deliveredFollowupCache.check(key, now);
}

export function resetDeliveredFollowupDedupe(): void {
  deliveredFollowupCache.clear();
}
