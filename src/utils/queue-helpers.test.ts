import { describe, expect, it, vi } from "vitest";
import {
  applyQueueDropPolicy,
  countPendingQueueItems,
  previewQueueSummaryPrompt,
  waitForQueueDebounce,
} from "./queue-helpers.js";

function createQueue<T>(items: T[], cap: number, dropPolicy: "old" | "summarize" = "old") {
  const summaryLines: string[] = [];
  return { items, cap, dropPolicy, droppedCount: 0, summaryLines };
}

type Item = { id: string; protected?: boolean };
function dropItems(queue: ReturnType<typeof createQueue<Item>>, inFlight?: Set<Item>) {
  const dropped: string[] = [];
  const admitted = applyQueueDropPolicy({
    queue,
    inFlight,
    summarize: (item) => item.id,
    isProtected: (item) => item.protected === true,
    onDrop: (items) => dropped.push(...items.map((item) => item.id)),
  });
  return { admitted, dropped };
}

describe("queue summary helpers", () => {
  it("preserves ordered summary elisions at the default limit", () => {
    const queue = {
      ...createQueue(["new"], 1, "summarize"),
      droppedCount: 2,
      summaryLines: ["first", "second"],
    };
    const calls: Array<[string, string[]]> = [];

    expect(
      applyQueueDropPolicy({
        queue,
        summarize: (item) => item,
        onDrop: (items) => calls.push(["drop", items]),
        onSummaryElide: (lines) => calls.push(["elide", lines]),
      }),
    ).toBe(true);

    expect(queue).toEqual({
      items: [],
      cap: 1,
      dropPolicy: "summarize",
      droppedCount: 3,
      summaryLines: ["new"],
    });
    expect(calls).toEqual([
      ["drop", ["new"]],
      ["elide", ["first", "second"]],
    ]);
  });

  it("renders pending summary state without mutating it", () => {
    const state = { droppedCount: 2, summaryLines: ["first", "second"] };
    const prompt = previewQueueSummaryPrompt(state);

    expect(prompt).toContain("[Queue overflow] Dropped 2 messages due to cap.");
    expect(prompt).toContain("first");
    expect(state).toEqual({ droppedCount: 2, summaryLines: ["first", "second"] });
  });

  it("keeps dropped-item previews free of lone surrogates", () => {
    const queue = createQueue([{ text: `${"a".repeat(158)}😀tail` }], 1, "summarize");

    applyQueueDropPolicy({ queue, summarize: (item) => item.text });

    expect(queue.summaryLines).toEqual([`${"a".repeat(158)}…`]);
  });
});

describe("waitForQueueDebounce", () => {
  it("resolves and removes the pending timer when cancelled", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const wait = waitForQueueDebounce(
        { debounceMs: 1_000, lastEnqueuedAt: Date.now() },
        controller.signal,
      );
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(250);
      controller.abort(new Error("turn cancelled"));

      await expect(wait).resolves.toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

  it("waits for a full quiet window after another item is enqueued", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");
    vi.useFakeTimers();
    try {
      const queue = { debounceMs: 1_000, lastEnqueuedAt: Date.now() };
      let settled = false;
      const wait = waitForQueueDebounce(queue).then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(500);
      queue.lastEnqueuedAt = Date.now();
      await vi.advanceTimersByTimeAsync(999);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      await wait;
      expect(settled).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

  it("settles one debounce window after the system clock moves backward", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");
    vi.useFakeTimers();
    try {
      const queue = { debounceMs: 1_000, lastEnqueuedAt: Date.now() };
      let settled = false;
      const wait = waitForQueueDebounce(queue).then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(500);
      vi.setSystemTime(Date.now() - 60 * 60_000);
      await vi.advanceTimersByTimeAsync(499);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      await wait;
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });
});

describe("queue overflow protection", () => {
  it("counts only in-flight identities that still intersect the queue", () => {
    const active = { id: "active" };
    const pending = { id: "pending" };
    const alreadyRemoved = { id: "already-removed" };

    expect(countPendingQueueItems([active, pending], new Set([active, alreadyRemoved]))).toBe(1);
  });

  it("skips in-flight items when selecting drop victims", () => {
    const [m1, m2, m3, m4] = [{ id: "m1" }, { id: "m2" }, { id: "m3" }, { id: "m4" }] as const;
    const queue = createQueue([m1, m2, m3, m4], 2);
    expect(dropItems(queue, new Set([m1])).dropped).toEqual(["m2", "m3"]);
    expect(queue.items).toEqual([m1, m4]);
  });

  it("skips protected items when selecting drop victims", () => {
    const protectedItem: Item = { id: "priority", protected: true };
    const [normalA, normalB, normalC] = [{ id: "a" }, { id: "b" }, { id: "c" }] as const;
    const queue = createQueue([protectedItem, normalA, normalB, normalC], 3);
    expect(dropItems(queue)).toEqual({ admitted: true, dropped: ["a", "b"] });
    expect(queue.items).toEqual([protectedItem, normalC]);
  });

  it.each([false, true])(
    "rejects protected-only pending work without mutation (in-flight=%s)",
    (active) => {
      const priority: Item = { id: "priority", protected: true };
      const first: Item = active ? { id: "active" } : { id: "also", protected: true };
      const queue = createQueue([first, priority], 1);
      expect(dropItems(queue, active ? new Set([first]) : undefined)).toEqual({
        admitted: false,
        dropped: [],
      });
      expect(queue.items).toEqual([first, priority]);
    },
  );
});
