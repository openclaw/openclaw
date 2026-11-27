import { describe, expect, it } from "vitest";
import {
  chatQueueMovableSegments,
  compareChatQueueOrder,
  isMovableChatQueueItem,
  reorderChatQueueItems,
} from "./chat-queue-order.ts";
import type { ChatQueueItem } from "./chat-types.ts";

function queued(id: string, createdAt: number): ChatQueueItem {
  return { id, text: id, createdAt };
}

function orderedIds(queue: readonly ChatQueueItem[]): string[] {
  return queue.toSorted(compareChatQueueOrder).map((item) => item.id);
}

function applyMove(queue: ChatQueueItem[], id: string, toIndex: number): ChatQueueItem[] {
  const changed = new Map(reorderChatQueueItems(queue, id, toIndex).map((item) => [item.id, item]));
  return queue.map((item) => changed.get(item.id) ?? item);
}

describe("chat queue order", () => {
  it("keeps a later arrival behind a reordered queue", () => {
    const moved = applyMove([queued("a", 10), queued("b", 20), queued("c", 30)], "c", 0);

    expect(orderedIds([...moved, queued("d", 40)])).toEqual(["c", "a", "b", "d"]);
  });

  it("separates rows that arrived in the same millisecond so the move sticks", () => {
    const queue = [queued("a", 10), queued("b", 10), queued("c", 10)];

    expect(orderedIds(applyMove(queue, "c", 0))).toEqual(["c", "a", "b"]);
  });

  it("changes nothing when the row is already at that index or absent", () => {
    const queue = [queued("a", 10), queued("b", 20)];

    expect(reorderChatQueueItems(queue, "a", 0)).toEqual([]);
    expect(reorderChatQueueItems(queue, "missing", 0)).toEqual([]);
  });

  it("takes the caller's predicate so a row held for another reason splits too", () => {
    const queue = [queued("a", 10), queued("b", 20), queued("c", 30)];

    const segments = chatQueueMovableSegments(
      queue,
      (item) => isMovableChatQueueItem(item) && item.id !== "b",
    );

    expect(segments.map((rows) => rows.map((row) => row.id))).toEqual([["a"], ["c"]]);
  });
});
