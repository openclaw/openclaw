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
      ...createQueue([], 1, "summarize"),
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

describe("queue overflow protection", () => {
  it.each`
    active   | protectedFirst | protectedLast | cap  | admitted | dropped
    ${true}  | ${false}       | ${false}      | ${2} | ${true}  | ${["a", "b"]}
    ${false} | ${true}        | ${false}      | ${3} | ${true}  | ${["a", "b"]}
    ${true}  | ${false}       | ${true}       | ${1} | ${false} | ${[]}
    ${false} | ${true}        | ${true}       | ${1} | ${false} | ${[]}
  `(
    "selects only droppable pending items (active=$active, admitted=$admitted)",
    ({ active, protectedFirst, protectedLast, cap, admitted, dropped }) => {
      const first: Item = { id: "first", protected: protectedFirst };
      const last: Item = { id: "c", protected: protectedLast };
      const items = admitted ? [first, { id: "a" }, { id: "b" }, last] : [first, last];
      const inFlight = active ? new Set([first, { id: "already-removed" }]) : undefined;
      expect(countPendingQueueItems(items, inFlight)).toBe(items.length - Number(active));
      const queue = createQueue(items, cap);
      expect(dropItems(queue, inFlight)).toEqual({ admitted, dropped });
      expect(queue.items).toEqual([first, last]);
    },
  );
});
