import { expect, it, vi } from "vitest";
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

it("previews without mutation, then bounds summaries in order without splitting surrogates", () => {
  const prefix = "a".repeat(158);
  const queue = {
    ...createQueue(["new", `${prefix}😀tail`], 1, "summarize"),
    droppedCount: 2,
    summaryLines: ["first", "second"],
  };
  const calls: Array<[string, string[]]> = [];
  const prompt = previewQueueSummaryPrompt(queue);
  expect(prompt).toContain("[Queue overflow] Dropped 2 messages due to cap.");
  expect(prompt).toContain("first");
  expect([queue.droppedCount, queue.summaryLines]).toEqual([2, ["first", "second"]]);
  const admitted = applyQueueDropPolicy({
    queue,
    summarize: (item) => item,
    onDrop: (items) => calls.push(["drop", items]),
    onSummaryElide: (lines) => calls.push(["elide", lines]),
  });
  expect(admitted).toBe(true);
  expect(queue.items).toEqual([]);
  expect([queue.droppedCount, queue.summaryLines]).toEqual([4, [`${prefix}…`]]);
  expect(calls).toEqual([
    ["drop", ["new", `${prefix}😀tail`]],
    ["elide", ["first", "second", "new"]],
  ]);
});

it.each(["cancel", "requeue", "rollback"])("settles debounce after %s", async (mode) => {
  vi.stubEnv("OPENCLAW_TEST_FAST", "0");
  vi.useFakeTimers();
  try {
    const queue = { debounceMs: 1_000, lastEnqueuedAt: Date.now() };
    const controller = new AbortController();
    const settled = vi.fn();
    const wait = waitForQueueDebounce(queue, controller.signal).then(settled);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(500);
    if (mode === "cancel") {
      controller.abort(new Error("turn cancelled"));
    } else {
      if (mode === "rollback") {
        vi.setSystemTime(Date.now() - 60 * 60_000);
      } else {
        queue.lastEnqueuedAt = Date.now();
      }
      await vi.advanceTimersByTimeAsync(mode === "rollback" ? 499 : 999);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
    }
    await wait;
    expect(settled).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  }
});

it.each([
  [true, false, false, 2, true],
  [false, true, false, 3, true],
  [true, false, true, 1, false],
  [false, true, true, 1, false],
] as const)(
  "protects queued work (active=%s, protectedFirst=%s, protectedLast=%s, cap=%s, admitted=%s)",
  (active, protectedFirst, protectedLast, cap, admitted) => {
    const first = { id: "first", protected: protectedFirst };
    const last = { id: "c", protected: protectedLast };
    const items: Item[] = admitted ? [first, { id: "a" }, { id: "b" }, last] : [first, last];
    const inFlight = active ? new Set([first, { id: "already-removed" }]) : undefined;
    expect(countPendingQueueItems(items, inFlight)).toBe(items.length - Number(active));
    const queue = createQueue(items, cap);
    const onDrop = vi.fn();
    const result = applyQueueDropPolicy<Item>({
      queue,
      inFlight,
      summarize: (item) => item.id,
      isProtected: (item) => item.protected === true,
      onDrop,
    });
    expect(result).toBe(admitted);
    expect(onDrop.mock.calls).toEqual(admitted ? [[[{ id: "a" }, { id: "b" }]]] : []);
    expect(queue.items).toEqual([first, last]);
  },
);
