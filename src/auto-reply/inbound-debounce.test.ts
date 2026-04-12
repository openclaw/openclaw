import { describe, expect, it, vi } from "vitest";
import { createInboundDebouncer } from "./inbound-debounce.js";

describe("createInboundDebouncer onEnrich", () => {
  it("enriches all items as batched when multiple items flush together", async () => {
    vi.useFakeTimers();
    const flushed: Array<Array<{ key: string; id: string; enrichments?: string[] }>> = [];
    const onEnrich = vi.fn(
      (
        item: { key: string; id: string; enrichments?: string[] },
        reason: "batched" | "queued",
      ) => ({
        ...item,
        enrichments: [...(item.enrichments ?? []), reason],
      }),
    );

    try {
      const debouncer = createInboundDebouncer<{
        key: string;
        id: string;
        enrichments?: string[];
      }>({
        debounceMs: 10,
        buildKey: (item) => item.key,
        onEnrich,
        onFlush: async (items) => {
          flushed.push(items);
        },
      });

      await debouncer.enqueue({ key: "a", id: "1" });
      await debouncer.enqueue({ key: "a", id: "2" });

      expect(flushed).toEqual([]);
      await vi.advanceTimersByTimeAsync(10);

      expect(flushed).toEqual([
        [
          { key: "a", id: "1", enrichments: ["batched"] },
          { key: "a", id: "2", enrichments: ["batched"] },
        ],
      ]);
      expect(onEnrich.mock.calls.map((call) => call[1])).toEqual(["batched", "batched"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not enrich single-item flushes when onEnrich is provided", async () => {
    vi.useFakeTimers();
    const flushed: Array<Array<{ key: string; id: string; enrichments?: string[] }>> = [];
    const onEnrich = vi.fn(
      (
        item: { key: string; id: string; enrichments?: string[] },
        reason: "batched" | "queued",
      ) => ({
        ...item,
        enrichments: [...(item.enrichments ?? []), reason],
      }),
    );

    try {
      const debouncer = createInboundDebouncer<{
        key: string;
        id: string;
        enrichments?: string[];
      }>({
        debounceMs: 10,
        buildKey: (item) => item.key,
        onEnrich,
        onFlush: async (items) => {
          flushed.push(items);
        },
      });

      await debouncer.enqueue({ key: "a", id: "1" });

      expect(flushed).toEqual([]);
      await vi.advanceTimersByTimeAsync(10);

      expect(flushed).toEqual([[{ key: "a", id: "1" }]]);
      expect(onEnrich).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps flush behavior unchanged when onEnrich is not provided", async () => {
    vi.useFakeTimers();
    const flushed: Array<Array<{ key: string; id: string; enrichments?: string[] }>> = [];

    try {
      const debouncer = createInboundDebouncer<{
        key: string;
        id: string;
        enrichments?: string[];
      }>({
        debounceMs: 10,
        buildKey: (item) => item.key,
        onFlush: async (items) => {
          flushed.push(items);
        },
      });

      await debouncer.enqueue({ key: "a", id: "1" });
      await debouncer.enqueue({ key: "a", id: "2" });

      expect(flushed).toEqual([]);
      await vi.advanceTimersByTimeAsync(10);

      expect(flushed).toEqual([
        [
          { key: "a", id: "1" },
          { key: "a", id: "2" },
        ],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("enriches later same-key items as queued while a keyed chain is active", async () => {
    const flushed: Array<
      Array<{ key: string; id: string; debounce: boolean; enrichments?: string[] }>
    > = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const onEnrich = vi.fn(
      (
        item: { key: string; id: string; debounce: boolean; enrichments?: string[] },
        reason: "batched" | "queued",
      ) => ({
        ...item,
        enrichments: [...(item.enrichments ?? []), reason],
      }),
    );

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const debouncer = createInboundDebouncer<{
      key: string;
      id: string;
      debounce: boolean;
      enrichments?: string[];
    }>({
      debounceMs: 50,
      buildKey: (item) => item.key,
      shouldDebounce: (item) => item.debounce,
      onEnrich,
      onFlush: async (items) => {
        flushed.push(items);
        if (items[0]?.id === "1") {
          await firstGate;
        }
      },
    });

    try {
      await debouncer.enqueue({ key: "a", id: "1", debounce: true });

      const timerIndex = setTimeoutSpy.mock.calls.findLastIndex((call) => call[1] === 50);
      expect(timerIndex).toBeGreaterThanOrEqual(0);
      clearTimeout(setTimeoutSpy.mock.results[timerIndex]?.value as ReturnType<typeof setTimeout>);
      const firstFlush = (
        setTimeoutSpy.mock.calls[timerIndex]?.[0] as (() => Promise<void>) | undefined
      )?.();

      await vi.waitFor(() => {
        expect(flushed).toEqual([[{ key: "a", id: "1", debounce: true }]]);
      });

      const second = debouncer.enqueue({ key: "a", id: "2", debounce: false });
      await Promise.resolve();

      expect(onEnrich).toHaveBeenCalledTimes(1);
      expect(onEnrich.mock.calls[0]?.[1]).toBe("queued");

      releaseFirst();
      await Promise.all([firstFlush, second]);

      expect(flushed).toEqual([
        [{ key: "a", id: "1", debounce: true }],
        [{ key: "a", id: "2", debounce: false, enrichments: ["queued"] }],
      ]);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("reports batched onEnrich failures and flushes the original items", async () => {
    vi.useFakeTimers();
    const onFlush = vi.fn(async () => {});
    const onError = vi.fn();
    const debouncer = createInboundDebouncer<{ key: string; id: string }>({
      debounceMs: 10,
      buildKey: (item) => item.key,
      onEnrich: () => {
        throw new Error("batched enrich failed");
      },
      onFlush,
      onError,
    });

    try {
      await debouncer.enqueue({ key: "a", id: "1" });
      await debouncer.enqueue({ key: "a", id: "2" });
      await vi.advanceTimersByTimeAsync(10);

      expect(onFlush).toHaveBeenCalledTimes(1);
      expect(onFlush).toHaveBeenCalledWith([
        { key: "a", id: "1" },
        { key: "a", id: "2" },
      ]);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
      expect(onError.mock.calls[0]?.[1]).toEqual([
        { key: "a", id: "1" },
        { key: "a", id: "2" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports queued onEnrich failures and flushes the original item", async () => {
    const onFlush = vi.fn(async (items: Array<{ key: string; id: string; debounce: boolean }>) => {
      if (items[0]?.id === "1") {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    });
    const onError = vi.fn();
    const onEnrich = vi.fn((item: { key: string; id: string; debounce: boolean }) => {
      if (item.id === "2") {
        throw new Error("queued enrich failed");
      }
      return item;
    });

    const debouncer = createInboundDebouncer<{ key: string; id: string; debounce: boolean }>({
      debounceMs: 50,
      buildKey: (item) => item.key,
      shouldDebounce: (item) => item.debounce,
      onEnrich,
      onFlush,
      onError,
    });

    await debouncer.enqueue({ key: "a", id: "1", debounce: true });
    const second = debouncer.enqueue({ key: "a", id: "2", debounce: false });
    await expect(second).resolves.toBeUndefined();

    expect(onFlush).toHaveBeenCalledTimes(2);
    expect(onFlush.mock.calls[1]?.[0]).toEqual([{ key: "a", id: "2", debounce: false }]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(onError.mock.calls[0]?.[1]).toEqual([{ key: "a", id: "2", debounce: false }]);
  });
});
