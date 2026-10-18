// Queue helper tests cover queue ordering and dedupe utility behavior.
import { describe, expect, it, vi } from "vitest";
import {
  applyQueueDropPolicy,
  applyQueueRuntimeSettings,
  countPendingQueueItems,
  previewQueueSummaryPrompt,
  waitForQueueDebounce,
} from "./queue-helpers.js";

function createQueue<T>(items: T[], cap: number, dropPolicy: "old" | "summarize" = "old") {
  const summaryLines: string[] = [];
  return { items, cap, dropPolicy, droppedCount: 0, summaryLines };
}

describe("applyQueueRuntimeSettings", () => {
  it("updates runtime queue settings with normalization", () => {
    const target = {
      mode: "followup" as const,
      debounceMs: 1000,
      cap: 20,
      dropPolicy: "summarize" as const,
    };

    applyQueueRuntimeSettings({
      target,
      settings: {
        mode: "collect",
        debounceMs: -12,
        cap: 9.8,
        dropPolicy: "new",
      },
    });

    expect(target).toEqual({
      mode: "collect",
      debounceMs: 0,
      cap: 9,
      dropPolicy: "new",
    });
  });

  it("keeps existing values when optional settings are missing/invalid", () => {
    const target = {
      mode: "followup" as const,
      debounceMs: 1000,
      cap: 20,
      dropPolicy: "summarize" as const,
    };

    applyQueueRuntimeSettings({
      target,
      settings: {
        mode: "queue",
        cap: 0,
      },
    });

    expect(target).toEqual({
      mode: "queue",
      debounceMs: 1000,
      cap: 20,
      dropPolicy: "summarize",
    });
  });
});

describe("queue summary helpers", () => {
  it.each([{ limit: undefined, retained: ["new"], elided: ["first", "second"] }])(
    "preserves ordered summary elisions at limit $limit",
    ({ limit, retained, elided }) => {
      const queue = {
        items: ["new"],
        cap: 1,
        dropPolicy: "summarize" as const,
        droppedCount: 2,
        summaryLines: ["first", "second"],
      };
      const calls: Array<[string, string[]]> = [];

      expect(
        applyQueueDropPolicy({
          queue,
          summaryLimit: limit,
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
        summaryLines: retained,
      });
      expect(calls).toEqual([["drop", ["new"]], ...(elided.length > 0 ? [["elide", elided]] : [])]);
    },
  );

  it("renders pending summary state without mutating it", () => {
    const state = {
      droppedCount: 2,
      summaryLines: ["first", "second"],
    };

    const prompt = previewQueueSummaryPrompt({
      state,
      noun: "message",
    });

    expect(prompt).toContain("[Queue overflow] Dropped 2 messages due to cap.");
    expect(prompt).toContain("first");
    expect(state).toEqual({
      droppedCount: 2,
      summaryLines: ["first", "second"],
    });
  });

  it("keeps dropped-item previews free of lone surrogates", () => {
    const queue = createQueue([{ text: `${"a".repeat(158)}😀tail` }], 1, "summarize");

    applyQueueDropPolicy({ queue, summarize: (item) => item.text });

    expect(queue.summaryLines).toEqual([`${"a".repeat(158)}…`]);
  });
});

describe("waitForQueueDebounce", () => {
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
    type Item = { id: string };
    const m1: Item = { id: "m1" };
    const m2: Item = { id: "m2" };
    const m3: Item = { id: "m3" };
    const m4: Item = { id: "m4" };
    const queue = createQueue([m1, m2, m3, m4], 2);
    const inFlight = new Set<Item>([m1]);
    const dropped: string[] = [];

    applyQueueDropPolicy({
      queue,
      inFlight,
      summarize: (item) => item.id,
      onDrop: (items) => {
        dropped.push(...items.map((item) => item.id));
      },
    });

    expect(dropped).toEqual(["m2", "m3"]);
    expect(queue.items).toEqual([m1, m4]);
  });

  it("skips protected items when selecting drop victims", () => {
    type Item = { id: string; protected?: boolean };
    const protectedItem: Item = { id: "priority", protected: true };
    const normalA: Item = { id: "a" };
    const normalB: Item = { id: "b" };
    const normalC: Item = { id: "c" };
    const queue = createQueue([protectedItem, normalA, normalB, normalC], 3);
    const dropped: string[] = [];

    // pending=4, cap=3 → drop 2 oldest unprotected; protected stays.
    const shouldEnqueue = applyQueueDropPolicy({
      queue,
      summarize: (item) => item.id,
      isProtected: (item) => item.protected === true,
      onDrop: (items) => {
        dropped.push(...items.map((item) => item.id));
      },
    });

    expect(shouldEnqueue).toBe(true);
    expect(dropped).toEqual(["a", "b"]);
    expect(queue.items).toEqual([protectedItem, normalC]);
  });

  it("rejects admission without mutating when only protected items can be dropped", () => {
    type Item = { id: string; protected?: boolean };
    const priority: Item = { id: "priority", protected: true };
    const alsoProtected: Item = { id: "also", protected: true };
    const queue = createQueue([priority, alsoProtected], 1);
    const dropped: string[] = [];

    const shouldEnqueue = applyQueueDropPolicy({
      queue,
      summarize: (item) => item.id,
      isProtected: (item) => item.protected === true,
      onDrop: (items) => {
        dropped.push(...items.map((item) => item.id));
      },
    });

    expect(shouldEnqueue).toBe(false);
    expect(dropped).toEqual([]);
    expect(queue.items).toEqual([priority, alsoProtected]);
  });

  it("rejects when pending work is only in-flight or protected", () => {
    type Item = { id: string; protected?: boolean };
    const active: Item = { id: "active" };
    const priority: Item = { id: "priority", protected: true };
    const queue = createQueue([active, priority], 1);
    const inFlight = new Set<Item>([active]);
    const dropped: string[] = [];

    const shouldEnqueue = applyQueueDropPolicy({
      queue,
      inFlight,
      summarize: (item) => item.id,
      isProtected: (item) => item.protected === true,
      onDrop: (items) => {
        dropped.push(...items.map((item) => item.id));
      },
    });

    expect(shouldEnqueue).toBe(false);
    expect(dropped).toEqual([]);
    expect(queue.items).toEqual([active, priority]);
  });
});
