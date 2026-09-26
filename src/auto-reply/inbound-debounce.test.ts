import { describe, expect, it, vi } from "vitest";
import { createInboundDebouncer, type InboundDebounceCreateParams } from "./inbound-debounce.js";

describe("createInboundDebouncer", () => {
  type TestInboundDebounceFlush = ReturnType<InboundDebounceCreateParams<unknown>["onFlush"]>;
  const flushOnCompletion = (dispatch: () => void | Promise<void>): TestInboundDebounceFlush => {
    const completion = Promise.resolve().then(dispatch);
    return { admission: completion, completion };
  };

  it("debounces and combines items", async () => {
    vi.useFakeTimers();
    const calls: Array<string[]> = [];

    const debouncer = createInboundDebouncer<{ key: string; id: string }>({
      debounceMs: 10,
      buildKey: (item) => item.key,
      onFlush: (items) =>
        flushOnCompletion(() => {
          calls.push(items.map((entry) => entry.id));
        }),
    });

    await debouncer.enqueue({ key: "a", id: "1" });
    await debouncer.enqueue({ key: "a", id: "2" });

    expect(calls).toStrictEqual([]);
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toEqual([["1", "2"]]);

    vi.useRealTimers();
  });

  it("seals bounded batches without blocking collection behind an active flush", async () => {
    vi.useFakeTimers();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const calls: number[][] = [];
    const debouncer = createInboundDebouncer<number>({
      debounceMs: 10,
      buildKey: () => "sender",
      canAppend: (_item, pending) => pending.length < 2,
      onFlush: (items) =>
        flushOnCompletion(async () => {
          calls.push(items);
          if (items[0] === 1) {
            await firstGate;
          }
        }),
    });
    try {
      for (const item of [1, 2, 3, 4, 5]) {
        await debouncer.enqueue(item);
      }
      await vi.advanceTimersByTimeAsync(10);
      expect(calls).toEqual([[1, 2]]);
      releaseFirst();
      await debouncer.drain();
      expect(calls).toEqual([[1, 2], [3, 4], [5]]);
    } finally {
      releaseFirst();
      await debouncer.drain();
      vi.useRealTimers();
    }
  });

  it("uses pending contents for continuation timing without carrying them into a full batch", async () => {
    vi.useFakeTimers();
    const calls: number[][] = [];
    const debouncer = createInboundDebouncer<number>({
      debounceMs: 0,
      buildKey: () => "sender",
      resolveDebounceMs: (item, pending) => (item === 1 || pending?.includes(1) ? 20 : 0),
      canAppend: (_item, pending) => pending.length < 2,
      onFlush: (items) =>
        flushOnCompletion(() => {
          calls.push(items);
        }),
    });
    try {
      expect(debouncer.shouldBuffer(1)).toBe(true);
      await debouncer.enqueue(1);
      expect(debouncer.shouldBuffer(2)).toBe(true);
      await debouncer.enqueue(2);
      expect(debouncer.shouldBuffer(3)).toBe(false);
      await debouncer.enqueue(3);
      await debouncer.drain();
      expect(calls).toEqual([[1, 2], [3]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes sustained same-key messages in complete, ordered batches", async () => {
    vi.useFakeTimers();
    try {
      const calls: Array<string[]> = [];
      const debouncer = createInboundDebouncer<{ key: string; id: string }>({
        debounceMs: 50,
        buildKey: (item) => item.key,
        onFlush: (items) =>
          flushOnCompletion(() => {
            calls.push(items.map((entry) => entry.id));
          }),
      });

      for (let index = 0; index < 12; index += 1) {
        await debouncer.enqueue({ key: "a", id: String(index) });
        await vi.advanceTimersByTimeAsync(20);
      }
      expect(calls).toStrictEqual([]);

      await debouncer.enqueue({ key: "a", id: "12" });
      await vi.advanceTimersByTimeAsync(10);
      expect(calls).toEqual([Array.from({ length: 13 }, (_, index) => String(index))]);

      for (let index = 13; index < 25; index += 1) {
        await debouncer.enqueue({ key: "a", id: String(index) });
        await vi.advanceTimersByTimeAsync(20);
      }
      expect(calls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(10);
      expect(calls).toEqual([
        Array.from({ length: 13 }, (_, index) => String(index)),
        Array.from({ length: 12 }, (_, index) => String(index + 13)),
      ]);
      await debouncer.drain();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([undefined, 500])("anchors the batch deadline (maximum wait: %s)", async (maxWaitMs) => {
    vi.useFakeTimers();
    try {
      const calls: Array<string[]> = [];
      const debouncer = createInboundDebouncer<{
        key: string;
        id: string;
        windowMs: number;
      }>({
        debounceMs: 0,
        maxWaitMs,
        buildKey: (item) => item.key,
        resolveDebounceMs: (item) => item.windowMs,
        onFlush: (items) =>
          flushOnCompletion(() => {
            calls.push(items.map((entry) => entry.id));
          }),
      });

      await debouncer.enqueue({ key: "a", id: "first", windowMs: 50 });
      await vi.advanceTimersByTimeAsync(40);
      await debouncer.enqueue({ key: "a", id: "later", windowMs: 1_000 });
      await vi.advanceTimersByTimeAsync((maxWaitMs ?? 250) - 41);
      expect(calls).toStrictEqual([]);

      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toEqual([["first", "later"]]);
      await debouncer.drain();
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes sustained messages even when the system clock moves backward", async () => {
    vi.useFakeTimers();
    try {
      const calls: Array<string[]> = [];
      const debouncer = createInboundDebouncer<{ key: string; id: string }>({
        debounceMs: 50,
        buildKey: (item) => item.key,
        onFlush: (items) =>
          flushOnCompletion(() => {
            calls.push(items.map((entry) => entry.id));
          }),
      });

      await debouncer.enqueue({ key: "a", id: "0" });
      for (let index = 1; index < 13; index += 1) {
        await vi.advanceTimersByTimeAsync(20);
        if (index === 6) {
          vi.setSystemTime(Date.now() - 60_000);
        }
        await debouncer.enqueue({ key: "a", id: String(index) });
      }
      expect(calls).toStrictEqual([]);

      await vi.advanceTimersByTimeAsync(10);
      expect(calls).toEqual([Array.from({ length: 13 }, (_, index) => String(index))]);
      await debouncer.drain();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports buffered items when cancelling a key", async () => {
    vi.useFakeTimers();
    const calls: Array<string[]> = [];
    const canceled: Array<string[]> = [];

    const debouncer = createInboundDebouncer<{ key: string; id: string }>({
      debounceMs: 10,
      buildKey: (item) => item.key,
      onFlush: (items) =>
        flushOnCompletion(() => {
          calls.push(items.map((entry) => entry.id));
        }),
      onCancel: (items) => {
        canceled.push(items.map((entry) => entry.id));
      },
    });

    await debouncer.enqueue({ key: "a", id: "1" });
    await debouncer.enqueue({ key: "a", id: "2" });
    expect(debouncer.cancelKey("a")).toBe(true);
    await vi.advanceTimersByTimeAsync(10);

    expect(canceled).toEqual([["1", "2"]]);
    expect(calls).toEqual([]);

    vi.useRealTimers();
  });

  it("cancels a released flush still waiting behind active same-key work", async () => {
    const calls: Array<string[]> = [];
    const canceled: Array<string[]> = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const debouncer = createInboundDebouncer<{ key: string; id: string }>({
      debounceMs: 50,
      buildKey: (item) => item.key,
      onFlush: (items) =>
        flushOnCompletion(async () => {
          const ids = items.map((entry) => entry.id);
          calls.push(ids);
          if (ids[0] === "1") {
            await firstGate;
          }
        }),
      onCancel: (items) => {
        canceled.push(items.map((entry) => entry.id));
      },
    });

    await debouncer.enqueue({ key: "a", id: "1" });
    const firstFlush = debouncer.flushKey("a");
    await vi.waitFor(() => expect(calls).toEqual([["1"]]));

    await debouncer.enqueue({ key: "a", id: "2" });
    const secondFlush = debouncer.flushKey("a");
    expect(debouncer.cancelKey("a")).toBe(true);
    expect(canceled).toEqual([["2"]]);

    await debouncer.enqueue({ key: "a", id: "3" });
    const thirdFlush = debouncer.flushKey("a");
    releaseFirst();
    await Promise.all([firstFlush, secondFlush, thirdFlush]);

    expect(canceled).toEqual([["2"]]);
    expect(calls).toEqual([["1"], ["3"]]);
  });

  it("flushes buffered items before non-debounced item", async () => {
    vi.useFakeTimers();
    const calls: Array<string[]> = [];

    const debouncer = createInboundDebouncer<{ key: string; id: string; debounce: boolean }>({
      debounceMs: 50,
      buildKey: (item) => item.key,
      shouldDebounce: (item) => item.debounce,
      onFlush: (items) =>
        flushOnCompletion(() => {
          calls.push(items.map((entry) => entry.id));
        }),
    });

    await debouncer.enqueue({ key: "a", id: "1", debounce: true });
    await debouncer.enqueue({ key: "a", id: "2", debounce: false });

    expect(calls).toEqual([["1"], ["2"]]);

    vi.useRealTimers();
  });

  it("supports per-item debounce windows when default debounce is disabled", async () => {
    vi.useFakeTimers();
    const calls: Array<string[]> = [];

    const debouncer = createInboundDebouncer<{ key: string; id: string; windowMs: number }>({
      debounceMs: 0,
      buildKey: (item) => item.key,
      resolveDebounceMs: (item) => item.windowMs,
      onFlush: (items) =>
        flushOnCompletion(() => {
          calls.push(items.map((entry) => entry.id));
        }),
    });

    await debouncer.enqueue({ key: "forward", id: "1", windowMs: 30 });
    await debouncer.enqueue({ key: "forward", id: "2", windowMs: 30 });

    expect(calls).toStrictEqual([]);
    await vi.advanceTimersByTimeAsync(30);
    expect(calls).toEqual([["1", "2"]]);

    vi.useRealTimers();
  });

  it("keeps later same-key work behind a timer-backed flush that already started", async () => {
    const started: string[] = [];
    const finished: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const debouncer = createInboundDebouncer<{ key: string; id: string; debounce: boolean }>({
      debounceMs: 50,
      buildKey: (item) => item.key,
      shouldDebounce: (item) => item.debounce,
      onFlush: (items) =>
        flushOnCompletion(async () => {
          const ids = items.map((entry) => entry.id).join(",");
          started.push(ids);
          if (ids === "1") {
            await firstGate;
          }
          finished.push(ids);
        }),
    });

    try {
      await debouncer.enqueue({ key: "a", id: "1", debounce: true });

      const timerIndex = setTimeoutSpy.mock.calls.findLastIndex((call) => call[1] === 50);
      expect(timerIndex).toBeGreaterThanOrEqual(0);
      clearTimeout(setTimeoutSpy.mock.results[timerIndex]?.value as ReturnType<typeof setTimeout>);
      const flushTimer = setTimeoutSpy.mock.calls[timerIndex]?.[0] as
        | (() => Promise<void>)
        | undefined;
      const firstFlush = flushTimer?.();

      await vi.waitFor(() => {
        expect(started).toEqual(["1"]);
      });

      const secondEnqueue = debouncer.enqueue({ key: "a", id: "2", debounce: false });
      await Promise.resolve();

      expect(started).toEqual(["1"]);
      expect(finished).toStrictEqual([]);

      if (!releaseFirst) {
        throw new Error("Expected first inbound debounce release callback to be initialized");
      }
      releaseFirst();
      await Promise.all([firstFlush, secondEnqueue]);

      expect(started).toEqual(["1", "2"]);
      expect(finished).toEqual(["1", "2"]);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("keeps fire-and-forget keyed work ahead of a later buffered item", async () => {
    const started: string[] = [];
    const finished: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const debouncer = createInboundDebouncer<{ key: string; id: string; debounce: boolean }>({
      debounceMs: 50,
      buildKey: (item) => item.key,
      shouldDebounce: (item) => item.debounce,
      onFlush: (items) =>
        flushOnCompletion(async () => {
          const ids = items.map((entry) => entry.id).join(",");
          started.push(ids);
          if (ids === "1") {
            await firstGate;
          }
          finished.push(ids);
        }),
    });

    try {
      await debouncer.enqueue({ key: "a", id: "1", debounce: true });

      const firstTimerIndex = setTimeoutSpy.mock.calls.findLastIndex((call) => call[1] === 50);
      expect(firstTimerIndex).toBeGreaterThanOrEqual(0);
      clearTimeout(
        setTimeoutSpy.mock.results[firstTimerIndex]?.value as ReturnType<typeof setTimeout>,
      );
      (setTimeoutSpy.mock.calls[firstTimerIndex]?.[0] as (() => void) | undefined)?.();

      await vi.waitFor(() => {
        expect(started).toEqual(["1"]);
      });

      const secondEnqueue = debouncer.enqueue({ key: "a", id: "2", debounce: false });
      const thirdEnqueue = debouncer.enqueue({ key: "a", id: "3", debounce: true });

      const thirdTimerIndex = setTimeoutSpy.mock.calls.findLastIndex(
        (call, index) => index > firstTimerIndex && call[1] === 50,
      );
      expect(thirdTimerIndex).toBeGreaterThan(firstTimerIndex);
      clearTimeout(
        setTimeoutSpy.mock.results[thirdTimerIndex]?.value as ReturnType<typeof setTimeout>,
      );
      (setTimeoutSpy.mock.calls[thirdTimerIndex]?.[0] as (() => void) | undefined)?.();

      await Promise.resolve();

      expect(started).toEqual(["1"]);
      expect(finished).toStrictEqual([]);

      if (!releaseFirst) {
        throw new Error("Expected first inbound debounce release callback to be initialized");
      }
      releaseFirst();
      await Promise.all([secondEnqueue, thirdEnqueue]);

      await vi.waitFor(() => {
        expect(started).toEqual(["1", "2", "3"]);
        expect(finished).toEqual(["1", "2", "3"]);
      });
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("does not serialize keyed turns by default when debounce is disabled", async () => {
    const started: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const debouncer = createInboundDebouncer<{ key: string; id: string }>({
      debounceMs: 0,
      buildKey: (item) => item.key,
      onFlush: (items) =>
        flushOnCompletion(async () => {
          const id = items[0]?.id ?? "";
          started.push(id);
          if (id === "1") {
            await firstGate;
          }
        }),
    });

    const first = debouncer.enqueue({ key: "a", id: "1" });
    await Promise.resolve();
    const second = debouncer.enqueue({ key: "a", id: "2" });
    await Promise.resolve();

    expect(started).toEqual(["1", "2"]);

    if (!releaseFirst) {
      throw new Error("Expected first inbound debounce release callback to be initialized");
    }
    releaseFirst();
    await Promise.all([first, second]);
  });

  it("serializes keyed turns when immediate serialization is enabled", async () => {
    const started: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const debouncer = createInboundDebouncer<{ key: string; id: string }>({
      debounceMs: 0,
      serializeImmediate: true,
      buildKey: (item) => item.key,
      onFlush: (items) =>
        flushOnCompletion(async () => {
          const id = items[0]?.id ?? "";
          started.push(id);
          if (id === "1") {
            await firstGate;
          }
        }),
    });

    const first = debouncer.enqueue({ key: "a", id: "1" });
    await Promise.resolve();
    const second = debouncer.enqueue({ key: "a", id: "2" });
    await Promise.resolve();

    expect(started).toEqual(["1"]);

    if (!releaseFirst) {
      throw new Error("Expected first inbound debounce release callback to be initialized");
    }
    releaseFirst();
    await Promise.all([first, second]);
    expect(started).toEqual(["1", "2"]);
  });

  it("releases a keyed chain at admission and drains full flush completions", async () => {
    const started: string[] = [];
    const completed: string[] = [];
    let releaseFirst!: () => void;
    const firstCompletion = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const debouncer = createInboundDebouncer<{ key: string; id: string }>({
      debounceMs: 50,
      buildKey: (item) => item.key,
      onFlush: (items, createFlush) =>
        createFlush({
          dispatch: async (lifecycle) => {
            const id = items[0]?.id ?? "";
            started.push(id);
            await lifecycle.onAdopted();
            if (id === "1") {
              await firstCompletion;
            }
            completed.push(id);
          },
        }),
    });

    await debouncer.enqueue({ key: "a", id: "1" });
    await debouncer.flushKey("a");
    await debouncer.enqueue({ key: "a", id: "2" });
    await debouncer.flushKey("a");

    expect(started).toEqual(["1", "2"]);
    expect(completed).toEqual(["2"]);

    let drained = false;
    const drain = debouncer.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    releaseFirst();
    await drain;
    expect(completed).toEqual(["2", "1"]);
  });

  it("hands pre-admission completion failures to the source lifecycle once", async () => {
    const sessionError = new Error("Session changed while starting work. Retry.");
    const onFailed = vi.fn(async () => {});
    const onError = vi.fn();
    let attempt = 0;
    const debouncer = createInboundDebouncer<{ key: string; id: string }>({
      debounceMs: 0,
      buildKey: (item) => item.key,
      onFlush: (_items, createFlush) =>
        createFlush({
          lifecycle: { onFailed },
          dispatch: async (lifecycle) => {
            attempt += 1;
            if (attempt === 1) {
              throw sessionError;
            }
            await lifecycle.onAdopted();
            throw new Error("post-adoption failure");
          },
        }),
      onError,
    });

    await expect(debouncer.enqueue({ key: "a", id: "failed-before-admission" })).resolves.toBe(
      undefined,
    );
    await expect(debouncer.enqueue({ key: "a", id: "failed-after-admission" })).resolves.toBe(
      undefined,
    );
    await debouncer.drain();

    expect(onFailed).toHaveBeenCalledOnce();
    expect(onFailed).toHaveBeenCalledWith(sessionError);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError.mock.calls[0]?.[0]).toBe(sessionError);
  });

  it("drains same-key flushes queued before their completion is tracked", async () => {
    const started: string[] = [];
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstCompletion = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondCompletion = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const debouncer = createInboundDebouncer<{ key: string; id: string }>({
      debounceMs: 50,
      buildKey: (item) => item.key,
      onFlush: (items, createFlush) =>
        createFlush({
          dispatch: async () => {
            const id = items[0]?.id ?? "";
            started.push(id);
            await (id === "1" ? firstCompletion : secondCompletion);
          },
        }),
    });

    await debouncer.enqueue({ key: "a", id: "1" });
    const firstFlush = debouncer.flushKey("a");
    await vi.waitFor(() => expect(started).toEqual(["1"]));
    await debouncer.enqueue({ key: "a", id: "2" });
    const secondFlush = debouncer.flushKey("a");

    let drained = false;
    const drain = debouncer.drain().then(() => {
      drained = true;
    });
    releaseFirst();
    await vi.waitFor(() => expect(started).toEqual(["1", "2"]));
    expect(drained).toBe(false);

    releaseSecond();
    await Promise.all([firstFlush, secondFlush, drain]);
    expect(drained).toBe(true);
  });

  it("swallows onError failures so keyed chains still complete", async () => {
    const calls: string[] = [];
    const debouncer = createInboundDebouncer<{ key: string; id: string }>({
      debounceMs: 0,
      buildKey: (item) => item.key,
      onFlush: (items) =>
        flushOnCompletion(() => {
          calls.push(items[0]?.id ?? "");
          throw new Error("flush failed");
        }),
      onError: () => {
        throw new Error("handler failed");
      },
    });

    await expect(debouncer.enqueue({ key: "a", id: "1" })).resolves.toBeUndefined();
    await expect(debouncer.enqueue({ key: "a", id: "2" })).resolves.toBeUndefined();

    expect(calls).toEqual(["1", "2"]);
  });

  it("releases serialized keys when custom completion rejects before admission", async () => {
    const failure = new Error("custom flush failed");
    const calls: string[] = [];
    const reported: unknown[] = [];
    const pendingAdmission = new Promise<void>(() => {});
    const debouncer = createInboundDebouncer<{ key: string; id: string }>({
      debounceMs: 0,
      serializeImmediate: true,
      buildKey: (item) => item.key,
      onFlush: (items) => {
        const id = items[0]?.id ?? "";
        calls.push(id);
        if (id === "first") {
          return { admission: pendingAdmission, completion: Promise.reject(failure) };
        }
        return flushOnCompletion(() => {});
      },
      onError: (error) => {
        reported.push(error);
        throw new Error("observer failed");
      },
    });

    const first = debouncer.enqueue({ key: "a", id: "first" });
    await vi.waitFor(() => expect(calls).toEqual(["first"]));
    const second = debouncer.enqueue({ key: "a", id: "second" });
    const secondOutcome = await Promise.race([
      second.then(() => "completed" as const),
      new Promise<"stalled">((resolve) => {
        setTimeout(() => resolve("stalled"), 100);
      }),
    ]);

    expect(secondOutcome).toBe("completed");
    await Promise.all([first, second, debouncer.drain()]);
    expect(calls).toEqual(["first", "second"]);
    expect(reported).toEqual([failure]);
  });

  it("does not leak unhandled rejections when a keyed flush failure is awaited", async () => {
    const debouncer = createInboundDebouncer<{ key: string; id: string }>({
      debounceMs: 0,
      buildKey: (item) => item.key,
      onFlush: () =>
        flushOnCompletion(() => {
          throw new Error("flush failed");
        }),
    });
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      await expect(debouncer.enqueue({ key: "a", id: "1" })).resolves.toBeUndefined();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(unhandled).toStrictEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("bypasses debouncing for new keys once the tracked-key cap is reached", async () => {
    vi.useFakeTimers();
    const calls: Array<string[]> = [];

    const debouncer = createInboundDebouncer<{ key: string; id: string }>({
      debounceMs: 50,
      maxTrackedKeys: 1,
      buildKey: (item) => item.key,
      onFlush: (items) =>
        flushOnCompletion(() => {
          calls.push(items.map((entry) => entry.id));
        }),
    });

    await debouncer.enqueue({ key: "a", id: "1" });
    await debouncer.enqueue({ key: "b", id: "2" });

    expect(calls).toEqual([["2"]]);

    await vi.advanceTimersByTimeAsync(50);
    expect(calls).toEqual([["2"], ["1"]]);

    vi.useRealTimers();
  });

  it("keeps same-key overflow work ordered after falling back to immediate flushes", async () => {
    const started: string[] = [];
    const finished: string[] = [];
    let releaseOverflow: (() => void) | undefined;
    const overflowGate = new Promise<void>((resolve) => {
      releaseOverflow = resolve;
    });

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const debouncer = createInboundDebouncer<{ key: string; id: string }>({
      debounceMs: 50,
      maxTrackedKeys: 1,
      buildKey: (item) => item.key,
      onFlush: (items) =>
        flushOnCompletion(async () => {
          const ids = items.map((entry) => entry.id).join(",");
          started.push(ids);
          if (ids === "2") {
            await overflowGate;
          }
          finished.push(ids);
        }),
    });

    try {
      await debouncer.enqueue({ key: "a", id: "1" });
      const callCountBeforeOverflow = setTimeoutSpy.mock.calls.length;
      clearTimeout(
        setTimeoutSpy.mock.results[callCountBeforeOverflow - 1]?.value as ReturnType<
          typeof setTimeout
        >,
      );

      const overflowEnqueue = debouncer.enqueue({ key: "b", id: "2" });
      await vi.waitFor(() => {
        expect(started).toEqual(["2"]);
      });

      const bufferedEnqueue = debouncer.enqueue({ key: "b", id: "3" });
      const bufferedTimerIndex = setTimeoutSpy.mock.calls.findLastIndex(
        (call, index) => index >= callCountBeforeOverflow && call[1] === 50,
      );
      expect(bufferedTimerIndex).toBeGreaterThanOrEqual(callCountBeforeOverflow);
      clearTimeout(
        setTimeoutSpy.mock.results[bufferedTimerIndex]?.value as ReturnType<typeof setTimeout>,
      );
      (setTimeoutSpy.mock.calls[bufferedTimerIndex]?.[0] as (() => void) | undefined)?.();

      await Promise.resolve();
      expect(started).toEqual(["2"]);
      expect(finished).toStrictEqual([]);

      if (!releaseOverflow) {
        throw new Error("Expected inbound overflow release callback to be initialized");
      }
      releaseOverflow();
      await Promise.all([overflowEnqueue, bufferedEnqueue]);

      await vi.waitFor(() => {
        expect(started).toEqual(["2", "3"]);
        expect(finished).toEqual(["2", "3"]);
      });
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("counts tracked debounce keys by union of buffers and active chains", async () => {
    const started: string[] = [];
    const finished: string[] = [];
    let releaseChainOnly: (() => void) | undefined;
    const chainOnlyGate = new Promise<void>((resolve) => {
      releaseChainOnly = resolve;
    });

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const debouncer = createInboundDebouncer<{ key: string; id: string }>({
      debounceMs: 50,
      maxTrackedKeys: 3,
      buildKey: (item) => item.key,
      onFlush: (items) =>
        flushOnCompletion(async () => {
          const ids = items.map((entry) => entry.id).join(",");
          started.push(ids);
          if (ids === "2") {
            await chainOnlyGate;
          }
          finished.push(ids);
        }),
    });

    try {
      await debouncer.enqueue({ key: "a", id: "1" });
      const firstTimerIndex = setTimeoutSpy.mock.calls.findLastIndex((call) => call[1] === 50);
      expect(firstTimerIndex).toBeGreaterThanOrEqual(0);
      clearTimeout(
        setTimeoutSpy.mock.results[firstTimerIndex]?.value as ReturnType<typeof setTimeout>,
      );

      await debouncer.enqueue({ key: "b", id: "2" });
      const secondTimerIndex = setTimeoutSpy.mock.calls.findLastIndex(
        (call, index) => index > firstTimerIndex && call[1] === 50,
      );
      expect(secondTimerIndex).toBeGreaterThan(firstTimerIndex);
      clearTimeout(
        setTimeoutSpy.mock.results[secondTimerIndex]?.value as ReturnType<typeof setTimeout>,
      );
      const secondFlush = (
        setTimeoutSpy.mock.calls[secondTimerIndex]?.[0] as (() => Promise<void>) | undefined
      )?.();

      await vi.waitFor(() => {
        expect(started).toEqual(["2"]);
      });

      await debouncer.enqueue({ key: "c", id: "3" });
      const timerCountBeforeOverflow = setTimeoutSpy.mock.calls.length;
      const thirdTimerIndex = setTimeoutSpy.mock.calls.findLastIndex(
        (call, index) => index > secondTimerIndex && call[1] === 50,
      );
      expect(thirdTimerIndex).toBeGreaterThan(secondTimerIndex);
      clearTimeout(
        setTimeoutSpy.mock.results[thirdTimerIndex]?.value as ReturnType<typeof setTimeout>,
      );

      const overflowEnqueue = debouncer.enqueue({ key: "d", id: "4" });

      expect(setTimeoutSpy.mock.calls).toHaveLength(timerCountBeforeOverflow);
      await vi.waitFor(() => {
        expect(started).toEqual(["2", "4"]);
        expect(finished).toEqual(["4"]);
      });

      if (!releaseChainOnly) {
        throw new Error("Expected inbound chain-only release callback to be initialized");
      }
      releaseChainOnly();
      await Promise.all([secondFlush, overflowEnqueue]);
      expect(finished).toEqual(["4", "2"]);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });
});
