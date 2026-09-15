// Recent-queue message-id dedupe shared by enqueue admission and abandonment release.
import { resolveGlobalDedupeCache } from "../../../infra/dedupe.js";
import type { TurnAdoptionLifecycle } from "../../get-reply-options.types.js";

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

/**
 * Reserve `key` for this admission and return its exact release.
 *
 * The lifecycle hook covers abandonment, but a run may legitimately carry no
 * `turnAdoptionLifecycle` (see `get-reply-run-execute.ts`). Callers that fail
 * durable admission must release the reservation directly, otherwise the
 * inbound retry of the same message is suppressed for the full TTL even though
 * nothing was ever admitted.
 */
export function recordRecentQueueMessageId(
  run: { turnAdoptionLifecycle?: TurnAdoptionLifecycle },
  key: string,
  now = Date.now(),
): () => void {
  const ownerToken = {};
  RECENT_QUEUE_MESSAGE_IDS.delete(key);
  RECENT_QUEUE_MESSAGE_IDS.check(key, now, ownerToken);
  // Owner-token delete frees only this entry; a later admission owns its own token.
  const release = () => {
    RECENT_QUEUE_MESSAGE_IDS.delete(key, ownerToken);
  };
  const lifecycle = run.turnAdoptionLifecycle;
  if (lifecycle) {
    const onAbandoned = lifecycle.onAbandoned;
    lifecycle.onAbandoned = () => {
      // Lifecycle callbacks survive summary cloning. Free only this entry before retry.
      release();
      onAbandoned?.();
    };
  }
  return release;
}

export function resetRecentQueuedMessageIdDedupe(): void {
  RECENT_QUEUE_MESSAGE_IDS.clear();
}
