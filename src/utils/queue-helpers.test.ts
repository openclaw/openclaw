import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  expect(
    applyQueueDropPolicy({
      queue,
      summarize: (item) => item,
      onDrop: (items) => calls.push(["drop", items]),
      onSummaryElide: (lines) => calls.push(["elide", lines]),
    }),
  ).toBe(true);

  expect(queue).toEqual({
    ...createQueue([], 1, "summarize"),
    droppedCount: 4,
    summaryLines: [`${prefix}…`],
  });
  expect(calls).toEqual([
    ["drop", ["new", `${prefix}😀tail`]],
    ["elide", ["first", "second", "new"]],
  ]);
});

describe("waitForQueueDebounce", () => {
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });
  it("resolves and removes the pending timer when cancelled", async () => {
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
  });
  it.each([false, true])("waits for the quiet window (clock rollback=%s)", async (rollback) => {
    const queue = { debounceMs: 1_000, lastEnqueuedAt: Date.now() };
    let settled = false;
    const wait = waitForQueueDebounce(queue).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(500);
    if (rollback) {
      vi.setSystemTime(Date.now() - 60 * 60_000);
    } else {
      queue.lastEnqueuedAt = Date.now();
    }
    await vi.advanceTimersByTimeAsync(rollback ? 499 : 999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    await wait;
    expect(vi.getTimerCount()).toBe(0);
  });
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
    expect(
      applyQueueDropPolicy({
        queue,
        inFlight,
        summarize: (item) => item.id,
        isProtected: (item) => item.protected === true,
        onDrop,
      }),
    ).toBe(admitted);
    expect(onDrop.mock.calls).toEqual(admitted ? [[[{ id: "a" }, { id: "b" }]]] : []);
    expect(queue.items).toEqual([first, last]);
  },
);
