import { getSafeLocalStorage } from "../local-storage.ts";
import type { ChatQueueItem } from "./ui-types.ts";

const CHAT_QUEUE_STORAGE_KEY_PREFIX = "oc.chatqueue:";

export const CHAT_QUEUE_TTL_MS = 86_400_000; // 24 hours

/** Persist the current chat queue for the active session. Removes the key when the
 * queue is empty to avoid stale entries accumulating across sessions. */
export function persistChatQueue(sessionKey: string, queue: ChatQueueItem[]): void {
  const storage = getSafeLocalStorage();
  if (!storage) {
    return;
  }
  try {
    const key = `${CHAT_QUEUE_STORAGE_KEY_PREFIX}${sessionKey}`;
    if (queue.length === 0) {
      // Drain complete — remove the stale entry so localStorage doesn't grow indefinitely.
      storage.removeItem(key);
      return;
    }
    const value = JSON.stringify({ items: queue, ts: Date.now() });
    storage.setItem(key, value);
  } catch {
    // Best-effort: localStorage may be unavailable (e.g. private browsing).
  }
}

/**
 * Restore a persisted chat queue for the given session, merging with any
 * items already in the in-memory queue (de-duplicated by id).
 * Items older than 24 hours are dropped.
 */
export function restoreChatQueue(
  sessionKey: string,
  currentQueue: ChatQueueItem[],
): ChatQueueItem[] {
  const storage = getSafeLocalStorage();
  if (!storage) {
    return currentQueue;
  }
  try {
    const raw = storage.getItem(`${CHAT_QUEUE_STORAGE_KEY_PREFIX}${sessionKey}`);
    if (!raw) {
      return currentQueue;
    }
    const parsed = JSON.parse(raw) as { items: ChatQueueItem[]; ts: number };
    if (Date.now() - parsed.ts > CHAT_QUEUE_TTL_MS) {
      storage.removeItem(`${CHAT_QUEUE_STORAGE_KEY_PREFIX}${sessionKey}`);
      return currentQueue;
    }
    const existingIds = new Set(currentQueue.map((i) => i.id));
    const newItems = parsed.items.filter((i) => !existingIds.has(i.id));
    if (newItems.length > 0) {
      return [...currentQueue, ...newItems];
    }
    return currentQueue;
  } catch {
    return currentQueue;
  }
}
