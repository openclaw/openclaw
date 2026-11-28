import type { ChatQueueItem } from "./chat-types.ts";

type ChatQueuePosition = Pick<ChatQueueItem, "createdAt" | "orderKey">;

// Reorders change orderKey while createdAt remains the arrival timestamp.
export function chatQueueOrderKey(item: ChatQueuePosition): number {
  return item.orderKey ?? item.createdAt;
}

// Display, drain, and alias merge share this order; stable sorting preserves tied arrivals.
export function compareChatQueueOrder(left: ChatQueuePosition, right: ChatQueuePosition): number {
  return chatQueueOrderKey(left) - chatQueueOrderKey(right);
}

// Submitted work and structured admissions retain their positions as delivery barriers.
export function isMovableChatQueueItem(item: ChatQueueItem): boolean {
  return (
    !item.pendingRunId &&
    !item.intent &&
    (item.sendAttempts ?? 0) === 0 &&
    (item.sendState === undefined ||
      item.sendState === "waiting-idle" ||
      item.sendState === "waiting-reconnect" ||
      item.sendState === "failed")
  );
}

// Moves cannot cross a locked row; callers may supply additional reasons to hold one.
export function chatQueueMovableSegments(
  queue: readonly ChatQueueItem[],
  isMovable: (item: ChatQueueItem) => boolean = isMovableChatQueueItem,
): ChatQueueItem[][] {
  const segments: ChatQueueItem[][] = [];
  let run: ChatQueueItem[] = [];
  for (const item of queue.toSorted(compareChatQueueOrder)) {
    if (isMovable(item)) {
      run.push(item);
      continue;
    }
    if (run.length > 0) {
      segments.push(run);
      run = [];
    }
  }
  if (run.length > 0) {
    segments.push(run);
  }
  return segments;
}

// Permute existing positions so later arrivals still sort behind the moved rows.
export function reorderChatQueueItems(
  queue: readonly ChatQueueItem[],
  id: string,
  toIndex: number,
): ChatQueueItem[] {
  const ordered = queue.toSorted(compareChatQueueOrder);
  const from = ordered.findIndex((item) => item.id === id);
  const to = Math.min(Math.max(toIndex, 0), ordered.length - 1);
  if (from < 0 || from === to) {
    return [];
  }
  const keys = ordered.map(chatQueueOrderKey);
  for (let index = 1; index < keys.length; index += 1) {
    // Same-millisecond arrivals would otherwise share a key and swallow the move.
    keys[index] = Math.max(keys[index]!, keys[index - 1]! + 1);
  }
  const moved = ordered.splice(from, 1)[0]!;
  ordered.splice(to, 0, moved);
  return ordered.flatMap((item, index) =>
    chatQueueOrderKey(item) === keys[index] ? [] : [{ ...item, orderKey: keys[index]! }],
  );
}
