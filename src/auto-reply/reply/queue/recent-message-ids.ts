import { resolveGlobalDedupeCache } from "../../../infra/dedupe.js";
import type { TurnAdoptionLifecycle } from "../../get-reply-options.types.js";
import { releaseBeforeTurnAdoptionRetry } from "./lifecycle.js";

const RECENT_QUEUE_MESSAGE_ID_TTL_MS = 5 * 60 * 1000;
const RECENT_QUEUE_MESSAGE_ID_MAX_SIZE = 10_000;

/**
 * Keep queued message-id dedupe shared across bundled chunks so redeliveries
 * are rejected no matter which chunk receives the enqueue call.
 */
const RECENT_QUEUE_MESSAGE_IDS = resolveGlobalDedupeCache(
  Symbol.for("openclaw.recentQueueMessageIdOwners"),
  {
    ttlMs: RECENT_QUEUE_MESSAGE_ID_TTL_MS,
    maxSize: RECENT_QUEUE_MESSAGE_ID_MAX_SIZE,
  },
);

export function peekRecentQueueMessageId(key: string, now = Date.now()): boolean {
  return RECENT_QUEUE_MESSAGE_IDS.peek(key, now);
}

export function recordRecentQueueMessageId(
  run: { turnAdoptionLifecycle?: TurnAdoptionLifecycle },
  key: string,
  now = Date.now(),
): void {
  const ownerToken = {};
  RECENT_QUEUE_MESSAGE_IDS.delete(key);
  RECENT_QUEUE_MESSAGE_IDS.check(key, now, ownerToken);
  const lifecycle = run.turnAdoptionLifecycle;
  if (lifecycle) {
    releaseBeforeTurnAdoptionRetry(lifecycle, () => {
      // Lifecycle callbacks survive summary cloning. Free only this entry before retry.
      RECENT_QUEUE_MESSAGE_IDS.delete(key, ownerToken);
    });
  }
}

export function resetRecentQueuedMessageIdDedupe(): void {
  RECENT_QUEUE_MESSAGE_IDS.clear();
}
