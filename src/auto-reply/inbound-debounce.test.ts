import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createInboundDebouncer, type InboundDebounceCreateParams } from "./inbound-debounce.js";

describe("createInboundDebouncer", () => {
  type TestInboundDebounceFlush = ReturnType<InboundDebounceCreateParams<unknown>["onFlush"]>;
  const flushOnCompletion = (dispatch: () => void | Promise<void>): TestInboundDebounceFlush => {
    const completion = Promise.resolve().then(dispatch);
    return { admission: completion, completion };
  };

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  type Message = { key: string; id: string };
  type RecordingOptions<T> = Omit<InboundDebounceCreateParams<T>, "buildKey" | "onFlush">;

  function createRecordingDebouncer<T extends Message = Message>(options: RecordingOptions<T>) {
    const calls: string[][] = [];
    const debouncer = createInboundDebouncer<T>({
      ...options,
      buildKey: (item) => item.key,
      onFlush: (items) =>
        flushOnCompletion(() => {
          calls.push(items.map((item) => item.id));
        }),
    });
    return { calls, debouncer };
  }

  function createBlockedDebouncer<T extends Message = Message>(
    options: RecordingOptions<T>,
    blockedId = "1",
  ) {
    const started: string[] = [];
    const finished: string[] = [];
    const entered = createDeferred();
    const release = createDeferred();
    const debouncer = createInboundDebouncer<T>({
      ...options,
      buildKey: (item) => item.key,
      onFlush: (items) =>
        flushOnCompletion(async () => {
          const ids = items.map((item) => item.id).join(",");
          started.push(ids);
          if (ids === blockedId) {
            entered.resolve();
            await release.promise;
          }
          finished.push(ids);
        }),
    });
    return { debouncer, started, finished, entered, release };
  }

  it("seals bounded batches without blocking collection behind an active flush", async () => {
    const firstGate = createDeferred();
    const calls: number[][] = [];
    const debouncer = createInboundDebouncer<number>({
      debounceMs: 10,
      buildKey: () => "sender",
      canAppend: (_item, pending) => pending.length < 2,
      onFlush: (items) =>
        flushOnCompletion(async () => {
          calls.push(items);
          if (items[0] === 1) {
            await firstGate.promise;
          }
        }),
    });
    try {
      for (const item of [1, 2, 3, 4, 5]) {
        await debouncer.enqueue(item);
      }
      await vi.advanceTimersByTimeAsync(10);
      expect(calls).toEqual([[1, 2]]);
      firstGate.resolve();
      await debouncer.drain();
      expect(calls).toEqual([[1, 2], [3, 4], [5]]);
    } finally {
      firstGate.resolve();
      await debouncer.drain();
    }
  });

  it("uses pending contents for continuation timing without carrying them into a full batch", async () => {
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
    expect(debouncer.shouldBuffer(1)).toBe(true);
    await debouncer.enqueue(1);
    expect(debouncer.shouldBuffer(2)).toBe(true);
    await debouncer.enqueue(2);
    expect(debouncer.shouldBuffer(3)).toBe(false);
    await debouncer.enqueue(3);
    await debouncer.drain();
    expect(calls).toEqual([[1, 2], [3]]);
  });

  it("flushes sustained same-key messages in complete, ordered batches", async () => {
    const { calls, debouncer } = createRecordingDebouncer({ debounceMs: 50 });

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
  });

  it.each([undefined, 500])("anchors the batch deadline (maximum wait: %s)", async (maxWaitMs) => {
    const { calls, debouncer } = createRecordingDebouncer<Message & { windowMs: number }>({
      debounceMs: 0,
      maxWaitMs,
      resolveDebounceMs: (item) => item.windowMs,
    });

    await debouncer.enqueue({ key: "a", id: "first", windowMs: 50 });
    await vi.advanceTimersByTimeAsync(40);
    await debouncer.enqueue({ key: "a", id: "later", windowMs: 1_000 });
    await vi.advanceTimersByTimeAsync((maxWaitMs ?? 250) - 41);
    expect(calls).toStrictEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual([["first", "later"]]);
    await debouncer.drain();
  });

  it("flushes sustained messages even when the system clock moves backward", async () => {
    const { calls, debouncer } = createRecordingDebouncer({ debounceMs: 50 });

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
  });

  it("re-arms the quiet window when the flush check holds the batch", async () => {
    const shouldHoldFlush = vi.fn(() => false).mockReturnValueOnce(true);
    const { calls, debouncer } = createRecordingDebouncer({ debounceMs: 10, shouldHoldFlush });

    await debouncer.enqueue({ key: "a", id: "1" });
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toEqual([]);

    await vi.advanceTimersByTimeAsync(9);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual([["1"]]);
    await debouncer.drain();
  });

  it.each([false, true])(
    "forces the deadline flush without another hold check (check pending: %s)",
    async (pending) => {
      const check = createDeferred<boolean>();
      const shouldHoldFlush = vi.fn(() => (pending ? check.promise : true));
      const { calls, debouncer } = createRecordingDebouncer({
        debounceMs: 10,
        maxWaitMs: 30,
        shouldHoldFlush,
      });

      await debouncer.enqueue({ key: "a", id: "1" });
      await vi.advanceTimersByTimeAsync(20);
      expect(calls).toEqual([]);

      await vi.advanceTimersByTimeAsync(10);
      expect(calls).toEqual([["1"]]);
      expect(shouldHoldFlush).toHaveBeenCalledTimes(pending ? 1 : 2);
      check.resolve(false);
      await debouncer.drain();
    },
  );

  it("flushes an explicit key without consulting the hold check", async () => {
    const shouldHoldFlush = vi.fn(() => true);
    const { calls, debouncer } = createRecordingDebouncer({ debounceMs: 10, shouldHoldFlush });

    await debouncer.enqueue({ key: "a", id: "1" });
    await debouncer.flushKey("a");

    expect(calls).toEqual([["1"]]);
    expect(shouldHoldFlush).not.toHaveBeenCalled();
    await debouncer.drain();
  });

  it("reports buffered items when cancelling a key", async () => {
    const canceled: Array<string[]> = [];

    const { calls, debouncer } = createRecordingDebouncer({
      debounceMs: 10,
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
  });

  it("cancels a released flush still waiting behind active same-key work", async () => {
    const calls: Array<string[]> = [];
    const canceled: Array<string[]> = [];
    const firstGate = createDeferred();
    const firstStarted = createDeferred();
    const debouncer = createInboundDebouncer<{ key: string; id: string }>({
      debounceMs: 50,
      buildKey: (item) => item.key,
      onFlush: (items) =>
        flushOnCompletion(async () => {
          const ids = items.map((entry) => entry.id);
          calls.push(ids);
          if (ids[0] === "1") {
            firstStarted.resolve();
            await firstGate.promise;
          }
        }),
      onCancel: (items) => {
        canceled.push(items.map((entry) => entry.id));
      },
    });

    await debouncer.enqueue({ key: "a", id: "1" });
    const firstFlush = debouncer.flushKey("a");
    await firstStarted.promise;
    expect(calls).toEqual([["1"]]);

    await debouncer.enqueue({ key: "a", id: "2" });
    const secondFlush = debouncer.flushKey("a");
    expect(debouncer.cancelKey("a")).toBe(true);
    expect(canceled).toEqual([["2"]]);

    await debouncer.enqueue({ key: "a", id: "3" });
    const thirdFlush = debouncer.flushKey("a");
    firstGate.resolve();
    await Promise.all([firstFlush, secondFlush, thirdFlush]);

    expect(canceled).toEqual([["2"]]);
    expect(calls).toEqual([["1"], ["3"]]);
  });

  it("cancels immediate work waiting behind an active flush without canceling later arrivals", async () => {
    const canceled: string[][] = [];
    const { debouncer, started, finished, entered, release } = createBlockedDebouncer({
      debounceMs: 50,
      shouldDebounce: (item) => item.id === "1",
      onCancel: (items) => canceled.push(items.map((item) => item.id)),
    });
    await debouncer.enqueue({ key: "a", id: "1" });
    const first = debouncer.flushKey("a");
    await entered.promise;
    const second = debouncer.enqueue({ key: "a", id: "2" });
    expect(debouncer.cancelKey("a")).toBe(true);
    const third = debouncer.enqueue({ key: "a", id: "3" });
    release.resolve();
    await Promise.all([first, second, third, debouncer.drain()]);
    expect(canceled).toEqual([["2"]]);
    expect(started).toEqual(["1", "3"]);
    expect(finished).toEqual(["1", "3"]);
  });

  it("flushes buffered items before non-debounced item", async () => {
    const { calls, debouncer } = createRecordingDebouncer<Message & { debounce: boolean }>({
      debounceMs: 50,
      shouldDebounce: (item) => item.debounce,
    });

    await debouncer.enqueue({ key: "a", id: "1", debounce: true });
    await debouncer.enqueue({ key: "a", id: "2", debounce: false });

    expect(calls).toEqual([["1"], ["2"]]);
  });

  it("supports per-item debounce windows when default debounce is disabled", async () => {
    const { calls, debouncer } = createRecordingDebouncer<Message & { windowMs: number }>({
      debounceMs: 0,
      resolveDebounceMs: (item) => item.windowMs,
    });

    await debouncer.enqueue({ key: "forward", id: "1", windowMs: 30 });
    await debouncer.enqueue({ key: "forward", id: "2", windowMs: 30 });

    expect(calls).toStrictEqual([]);
    await vi.advanceTimersByTimeAsync(30);
    expect(calls).toEqual([["1", "2"]]);
  });

  it("keeps fire-and-forget keyed work ahead of a later buffered item", async () => {
    const { debouncer, started, finished, release } = createBlockedDebouncer<
      Message & { debounce: boolean }
    >({ debounceMs: 50, shouldDebounce: (item) => item.debounce });
    await debouncer.enqueue({ key: "a", id: "1", debounce: true });
    await vi.advanceTimersByTimeAsync(50);
    expect(started).toEqual(["1"]);

    const second = debouncer.enqueue({ key: "a", id: "2", debounce: false });
    const third = debouncer.enqueue({ key: "a", id: "3", debounce: true });
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(started).toEqual(["1"]);
    expect(finished).toStrictEqual([]);

    release.resolve();
    await Promise.all([second, third, debouncer.drain()]);
    expect(started).toEqual(["1", "2", "3"]);
    expect(finished).toEqual(["1", "2", "3"]);
  });

  it.each([undefined, true])(
    "serializes immediate keyed turns only when enabled (%s)",
    async (serializeImmediate) => {
      const { debouncer, started, release } = createBlockedDebouncer({
        debounceMs: 0,
        serializeImmediate,
      });
      const first = debouncer.enqueue({ key: "a", id: "1" });
      await Promise.resolve();
      const second = debouncer.enqueue({ key: "a", id: "2" });
      await Promise.resolve();
      expect(started).toEqual(serializeImmediate ? ["1"] : ["1", "2"]);

      release.resolve();
      await Promise.all([first, second]);
      expect(started).toEqual(["1", "2"]);
    },
  );

  it("releases a keyed chain at admission and drains full flush completions", async () => {
    const started: string[] = [];
    const completed: string[] = [];
    const firstCompletion = createDeferred();
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
              await firstCompletion.promise;
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

    firstCompletion.resolve();
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
    const firstCompletion = createDeferred();
    const secondCompletion = createDeferred();
    const firstStarted = createDeferred();
    const secondStarted = createDeferred();
    const debouncer = createInboundDebouncer<{ key: string; id: string }>({
      debounceMs: 50,
      buildKey: (item) => item.key,
      onFlush: (items, createFlush) =>
        createFlush({
          dispatch: async () => {
            const id = items[0]?.id ?? "";
            started.push(id);
            (id === "1" ? firstStarted : secondStarted).resolve();
            await (id === "1" ? firstCompletion : secondCompletion).promise;
          },
        }),
    });

    await debouncer.enqueue({ key: "a", id: "1" });
    const firstFlush = debouncer.flushKey("a");
    await firstStarted.promise;
    expect(started).toEqual(["1"]);
    await debouncer.enqueue({ key: "a", id: "2" });
    const secondFlush = debouncer.flushKey("a");

    let drained = false;
    const drain = debouncer.drain().then(() => {
      drained = true;
    });
    firstCompletion.resolve();
    await secondStarted.promise;
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(["1", "2"]);
    expect(drained).toBe(false);

    secondCompletion.resolve();
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
    expect(calls).toEqual(["first"]);
    const second = debouncer.enqueue({ key: "a", id: "second" });
    await expect(second).resolves.toBeUndefined();
    await Promise.all([first, second, debouncer.drain()]);
    expect(calls).toEqual(["first", "second"]);
    expect(reported).toEqual([failure]);
  });

  it("does not leak unhandled rejections when a keyed flush failure is awaited", async () => {
    vi.useRealTimers();
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
    const { calls, debouncer } = createRecordingDebouncer({
      debounceMs: 50,
      maxTrackedKeys: 1,
    });

    await debouncer.enqueue({ key: "a", id: "1" });
    await debouncer.enqueue({ key: "b", id: "2" });

    expect(calls).toEqual([["2"]]);

    await vi.advanceTimersByTimeAsync(50);
    expect(calls).toEqual([["2"], ["1"]]);
  });

  it("keeps same-key overflow work ordered after falling back to immediate flushes", async () => {
    const { debouncer, started, finished, entered, release } = createBlockedDebouncer(
      { debounceMs: 50, maxTrackedKeys: 1 },
      "2",
    );
    await debouncer.enqueue({ key: "a", id: "1" });
    const overflow = debouncer.enqueue({ key: "b", id: "2" });
    await entered.promise;
    expect(started).toEqual(["2"]);
    const buffered = debouncer.enqueue({ key: "b", id: "3" });
    expect(vi.getTimerCount()).toBe(2);
    // Cancel the unrelated key so advancing the clock isolates the overflow chain.
    debouncer.cancelKey("a");
    await vi.advanceTimersByTimeAsync(50);
    expect(started).toEqual(["2"]);
    expect(finished).toStrictEqual([]);

    release.resolve();
    await Promise.all([overflow, buffered, debouncer.drain()]);
    expect(started).toEqual(["2", "3"]);
    expect(finished).toEqual(["2", "3"]);
  });

  it("counts tracked debounce keys by union of buffers and active chains", async () => {
    const { debouncer, started, finished, entered, release } = createBlockedDebouncer(
      { debounceMs: 50, maxTrackedKeys: 3 },
      "2",
    );
    await debouncer.enqueue({ key: "a", id: "1" });
    await debouncer.enqueue({ key: "b", id: "2" });
    const secondFlush = debouncer.flushKey("b");
    await entered.promise;
    expect(started).toEqual(["2"]);
    await debouncer.enqueue({ key: "c", id: "3" });
    expect(vi.getTimerCount()).toBe(2);

    await debouncer.enqueue({ key: "d", id: "4" });
    expect(vi.getTimerCount()).toBe(2);
    expect(started).toEqual(["2", "4"]);
    expect(finished).toEqual(["4"]);

    release.resolve();
    await secondFlush;
    expect(finished).toEqual(["4", "2"]);
    debouncer.cancelKey("a");
    debouncer.cancelKey("c");
    await debouncer.drain();
  });
});
