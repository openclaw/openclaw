import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { enqueueCommandInLane } from "../process/command-queue.js";
import {
  GatewayDrainingError,
  getActiveGatewayRootWorkCount,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
  tryBeginGatewaySuspendAdmission,
} from "../process/gateway-work-admission.js";
import { createInboundDebouncer, type InboundDebounceCreateParams } from "./inbound-debounce.js";

describe("createInboundDebouncer", () => {
  type TestInboundDebounceFlush = ReturnType<InboundDebounceCreateParams<unknown>["onFlush"]>;
  const flushOnCompletion = (dispatch: () => void | Promise<void>): TestInboundDebounceFlush => {
    const completion = Promise.resolve().then(dispatch);
    return { admission: completion, completion };
  };

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  afterEach(resetGatewayWorkAdmission);

  type Message = { key: string; id: string };
  type RecordingOptions<T> = Omit<
    InboundDebounceCreateParams<T>,
    "buildKey" | "onFlush" | "debounceMs"
  > & { debounceMs?: number };
  type KeyedOptions = Omit<InboundDebounceCreateParams<Message>, "buildKey" | "debounceMs"> & {
    debounceMs?: number;
  };
  const keyedDebouncer = (options: KeyedOptions) =>
    createInboundDebouncer<Message>({ debounceMs: 0, buildKey: (item) => item.key, ...options });
  async function tick<T>(ms: number, calls: T[], expected: T[]) {
    await vi.advanceTimersByTimeAsync(ms);
    expect(calls).toStrictEqual(expected);
  }
  type FlushOptions = Parameters<Parameters<KeyedOptions["onFlush"]>[1]>[0];
  function lifecycleDebouncer(
    dispatch: (id: string, lifecycle: Parameters<FlushOptions["dispatch"]>[0]) => Promise<void>,
    options: Omit<KeyedOptions, "onFlush"> & Pick<FlushOptions, "lifecycle"> = {},
  ) {
    const { lifecycle, ...debounce } = options;
    return keyedDebouncer({
      ...debounce,
      onFlush: (items, createFlush) =>
        createFlush({ lifecycle, dispatch: (turn) => dispatch(items[0]?.id ?? "", turn) }),
    });
  }
  function numberDebouncer(
    options: RecordingOptions<number>,
    onBatch: (items: number[]) => void | Promise<void> = () => {},
  ) {
    const calls: number[][] = [];
    const debouncer = createInboundDebouncer({
      debounceMs: 0,
      ...options,
      buildKey: () => "sender",
      onFlush: (items: number[]) =>
        flushOnCompletion(() => {
          calls.push(items);
          return onBatch(items);
        }),
    });
    return { calls, debouncer };
  }

  function createRecordingDebouncer<T extends Message = Message>(options: RecordingOptions<T>) {
    const calls: string[][] = [];
    const debouncer = createInboundDebouncer<T>({
      debounceMs: 50,
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
      debounceMs: 50,
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

  it.each([false, true])(
    "waits for shipped flush callbacks when ordering and draining (thenable: %s)",
    async (thenable) => {
      const started: string[] = [];
      const finished: string[] = [];
      const firstCompletion = createDeferred();
      const debouncer = keyedDebouncer({
        serializeImmediate: true,
        // @ts-expect-error Released plugins return promises instead of the current lifecycle shape.
        onFlush: (items) => {
          const id = items[0]?.id ?? "";
          started.push(id);
          const completion = (id === "first" ? firstCompletion.promise : Promise.resolve()).then(
            () => {
              finished.push(id);
            },
          );
          // oxlint-disable-next-line unicorn/no-thenable -- Exercise a shipped structural PromiseLike callback.
          return thenable ? { then: completion.then.bind(completion) } : completion;
        },
      });
      const first = debouncer.enqueue({ key: "a", id: "first" });
      const second = debouncer.enqueue({ key: "a", id: "second" });
      const outcomes = Promise.allSettled([first, second]);
      const onDrained = vi.fn();
      const drain = debouncer.drain().then(onDrained);
      let beforeRelease;
      try {
        await vi.advanceTimersByTimeAsync(0);
        beforeRelease = { started: [...started], drained: onDrained.mock.calls.length };
      } finally {
        firstCompletion.resolve();
        await Promise.all([outcomes, drain]);
      }

      expect(await outcomes).toEqual([
        { status: "fulfilled", value: undefined },
        { status: "fulfilled", value: undefined },
      ]);
      expect(beforeRelease).toEqual({ started: ["first"], drained: 0 });
      expect(finished).toEqual(["first", "second"]);
      expect(onDrained).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])(
    "reports a shipped flush rejection once and releases its key (thenable: %s)",
    async (thenable) => {
      const failure = new Error("legacy flush failed");
      const onError = vi.fn();
      const calls: string[] = [];
      const debouncer = keyedDebouncer({
        serializeImmediate: true,
        // @ts-expect-error Released plugins return promises instead of the current lifecycle shape.
        onFlush: (items) => {
          const id = items[0]?.id ?? "";
          calls.push(id);
          const completion = id === "first" ? Promise.reject(failure) : Promise.resolve();
          // oxlint-disable-next-line unicorn/no-thenable -- Exercise a shipped structural PromiseLike callback.
          return thenable ? { then: completion.then.bind(completion) } : completion;
        },
        onError,
      });

      await expect(debouncer.enqueue({ key: "a", id: "first" })).resolves.toBeUndefined();
      await expect(debouncer.enqueue({ key: "a", id: "second" })).resolves.toBeUndefined();
      await debouncer.drain();

      expect(onError).toHaveBeenCalledExactlyOnceWith(failure, [{ key: "a", id: "first" }]);
      expect(calls).toEqual(["first", "second"]);
    },
  );

  it("seals bounded batches without blocking collection behind an active flush", async () => {
    const firstGate = createDeferred();
    const { calls, debouncer } = numberDebouncer(
      { debounceMs: 10, canAppend: (_item, pending) => pending.length < 2 },
      async (items) => {
        if (items[0] === 1) {
          await firstGate.promise;
        }
      },
    );
    try {
      for (const item of [1, 2, 3, 4, 5]) {
        await debouncer.enqueue(item);
      }
      await tick(10, calls, [[1, 2]]);
      firstGate.resolve();
      await debouncer.drain();
      expect(calls).toEqual([[1, 2], [3, 4], [5]]);
    } finally {
      firstGate.resolve();
      await debouncer.drain();
    }
  });

  it("uses pending contents for continuation timing without carrying them into a full batch", async () => {
    const { calls, debouncer } = numberDebouncer({
      debounceMs: 0,
      resolveDebounceMs: (item, pending) => (item === 1 || pending?.includes(1) ? 20 : 0),
      canAppend: (_item, pending) => pending.length < 2,
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

  it.each([undefined, 500])("anchors the batch deadline (maximum wait: %s)", async (maxWaitMs) => {
    const { calls, debouncer } = createRecordingDebouncer<Message & { windowMs: number }>({
      debounceMs: 0,
      maxWaitMs,
      resolveDebounceMs: (item) => item.windowMs,
    });

    await debouncer.enqueue({ key: "a", id: "first", windowMs: 50 });
    await vi.advanceTimersByTimeAsync(40);
    await debouncer.enqueue({ key: "a", id: "later", windowMs: 1_000 });
    await tick((maxWaitMs ?? 250) - 41, calls, []);

    await tick(1, calls, [["first", "later"]]);
    await debouncer.drain();
  });

  it("flushes sustained messages even when the system clock moves backward", async () => {
    const { calls, debouncer } = createRecordingDebouncer({});

    await debouncer.enqueue({ key: "a", id: "0" });
    for (let index = 1; index < 13; index += 1) {
      await vi.advanceTimersByTimeAsync(20);
      if (index === 6) {
        vi.setSystemTime(Date.now() - 60_000);
      }
      await debouncer.enqueue({ key: "a", id: String(index) });
    }
    expect(calls).toStrictEqual([]);

    await tick(10, calls, [Array.from({ length: 13 }, (_, index) => String(index))]);
    await debouncer.drain();
  });

  it("re-arms the quiet window when the flush check holds the batch", async () => {
    const shouldHoldFlush = vi.fn(() => false).mockReturnValueOnce(true);
    const { calls, debouncer } = createRecordingDebouncer({ debounceMs: 10, shouldHoldFlush });

    await debouncer.enqueue({ key: "a", id: "1" });
    await tick(10, calls, []);

    await tick(9, calls, []);
    await tick(1, calls, [["1"]]);
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
      await tick(20, calls, []);

      await tick(10, calls, [["1"]]);
      expect(shouldHoldFlush).toHaveBeenCalledTimes(pending ? 1 : 2);
      check.resolve(false);
      await debouncer.drain();
    },
  );

  it.each([false, true])(
    "cancels queued work but preserves later arrivals (immediate: %s)",
    async (immediate) => {
      const canceled: string[][] = [];
      const { debouncer, started, finished, entered, release } = createBlockedDebouncer({
        shouldDebounce: (item) => !immediate || item.id === "1",
        onCancel: (items) => canceled.push(items.map((item) => item.id)),
      });
      await debouncer.enqueue({ key: "a", id: "1" });
      const first = debouncer.flushKey("a");
      await entered.promise;
      expect(started).toEqual(["1"]);
      const secondEnqueue = debouncer.enqueue({ key: "a", id: "2" });
      if (!immediate) {
        await secondEnqueue;
      }
      const second = immediate ? secondEnqueue : debouncer.flushKey("a");
      expect(debouncer.cancelKey("a")).toBe(true);
      expect(canceled).toEqual([["2"]]);
      const thirdEnqueue = debouncer.enqueue({ key: "a", id: "3" });
      if (!immediate) {
        await thirdEnqueue;
      }
      const third = immediate ? thirdEnqueue : debouncer.flushKey("a");
      release.resolve();
      await Promise.all([first, second, third, debouncer.drain()]);
      expect(canceled).toEqual([["2"]]);
      expect({ started, finished }).toStrictEqual({ started: ["1", "3"], finished: ["1", "3"] });
    },
  );

  it("keeps fire-and-forget keyed work ahead of a later buffered item", async () => {
    const { debouncer, started, finished, release } = createBlockedDebouncer<
      Message & { debounce: boolean }
    >({ shouldDebounce: (item) => item.debounce });
    await debouncer.enqueue({ key: "a", id: "1", debounce: true });
    await tick(50, started, ["1"]);

    const second = debouncer.enqueue({ key: "a", id: "2", debounce: false });
    const third = debouncer.enqueue({ key: "a", id: "3", debounce: true });
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(50);
    expect({ started, finished }).toStrictEqual({ started: ["1"], finished: [] });

    release.resolve();
    await Promise.all([second, third, debouncer.drain()]);
    expect({ started, finished }).toStrictEqual({
      started: ["1", "2", "3"],
      finished: ["1", "2", "3"],
    });
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
    const debouncer = lifecycleDebouncer(
      async (id, lifecycle) => {
        started.push(id);
        await lifecycle.onAdopted();
        if (id === "1") {
          await firstCompletion.promise;
        }
        completed.push(id);
      },
      { debounceMs: 50 },
    );

    await debouncer.enqueue({ key: "a", id: "1" });
    await debouncer.flushKey("a");
    await debouncer.enqueue({ key: "a", id: "2" });
    await debouncer.flushKey("a");

    expect(started).toEqual(["1", "2"]);
    expect(completed).toEqual(["2"]);

    const onDrained = vi.fn();
    const drain = debouncer.drain().then(onDrained);
    await Promise.resolve();
    expect(onDrained).not.toHaveBeenCalled();

    firstCompletion.resolve();
    await drain;
    expect(completed).toEqual(["2", "1"]);
  });

  it.each(["accepting", "suspended", "restarting"] as const)(
    "keeps adopted immediate dispatch owned after HTTP request release (%s)",
    async (phase) => {
      const execute = createDeferred();
      const reply = vi.fn(async () => {});
      const onError = vi.fn();
      const debouncer = lifecycleDebouncer(
        async (_id, lifecycle) => {
          await lifecycle.onAdopted();
          await execute.promise;
          await enqueueCommandInLane("inbound-adopted-turn", reply);
        },
        { onError },
      );
      const request = tryBeginGatewayRootWorkAdmission("http:request");
      if (!request) {
        throw new Error("Expected HTTP request admission");
      }
      try {
        await request.run(() => debouncer.enqueue({ key: "a", id: "1" }));
        request.release();
        expect(reply).not.toHaveBeenCalled();
        if (phase === "suspended") {
          const suspension = tryBeginGatewaySuspendAdmission(() => {});
          expect(suspension).not.toBeNull();
          // New requests are refused while this already-adopted turn finishes.
          expect(tryBeginGatewayRootWorkAdmission("http:request")).toBeNull();
        } else if (phase === "restarting") {
          markGatewayRestartDraining();
        }
        execute.resolve();
        await debouncer.drain();
        if (phase === "restarting") {
          expect(reply).not.toHaveBeenCalled();
          expect(onError).toHaveBeenCalledExactlyOnceWith(expect.any(GatewayDrainingError), [
            { key: "a", id: "1" },
          ]);
        } else {
          expect(onError).not.toHaveBeenCalled();
          expect(reply).toHaveBeenCalledOnce();
        }
        expect(getActiveGatewayRootWorkCount()).toBe(0);
      } finally {
        request.release();
        execute.resolve();
        await debouncer.drain();
      }
    },
  );

  it("hands pre-admission completion failures to the source lifecycle once", async () => {
    const sessionError = new Error("Session changed while starting work. Retry.");
    const onFailed = vi.fn(async () => {});
    const onError = vi.fn();
    let attempt = 0;
    const debouncer = lifecycleDebouncer(
      async (_id, lifecycle) => {
        attempt += 1;
        if (attempt === 1) {
          throw sessionError;
        }
        await lifecycle.onAdopted();
        throw new Error("post-adoption failure");
      },
      { lifecycle: { onFailed }, onError },
    );

    await expect(debouncer.enqueue({ key: "a", id: "before" })).resolves.toBeUndefined();
    await expect(debouncer.enqueue({ key: "a", id: "after" })).resolves.toBeUndefined();
    await debouncer.drain();

    expect(onFailed).toHaveBeenCalledExactlyOnceWith(sessionError);
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError.mock.calls[0]?.[0]).toBe(sessionError);
  });

  it("drains same-key flushes queued before their completion is tracked", async () => {
    const started: string[] = [];
    const firstCompletion = createDeferred();
    const secondCompletion = createDeferred();
    const firstStarted = createDeferred();
    const secondStarted = createDeferred();
    const debouncer = lifecycleDebouncer(
      async (id) => {
        started.push(id);
        (id === "1" ? firstStarted : secondStarted).resolve();
        await (id === "1" ? firstCompletion : secondCompletion).promise;
      },
      { debounceMs: 50 },
    );

    await debouncer.enqueue({ key: "a", id: "1" });
    const firstFlush = debouncer.flushKey("a");
    await firstStarted.promise;
    expect(started).toEqual(["1"]);
    await debouncer.enqueue({ key: "a", id: "2" });
    const secondFlush = debouncer.flushKey("a");

    const onDrained = vi.fn();
    const drain = debouncer.drain().then(onDrained);
    firstCompletion.resolve();
    await secondStarted.promise;
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual(["1", "2"]);
    expect(onDrained).not.toHaveBeenCalled();

    secondCompletion.resolve();
    await Promise.all([firstFlush, secondFlush, drain]);
    expect(onDrained).toHaveBeenCalledOnce();
  });

  it("releases serialized keys when custom completion rejects before admission", async () => {
    const failure = new Error("custom flush failed");
    const calls: string[] = [];
    const reported: unknown[] = [];
    const pendingAdmission = new Promise<void>(() => {});
    const debouncer = keyedDebouncer({
      serializeImmediate: true,
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
    const debouncer = keyedDebouncer({
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

  it("keeps same-key overflow work ordered after falling back to immediate flushes", async () => {
    const { debouncer, started, finished, entered, release } = createBlockedDebouncer(
      { maxTrackedKeys: 1 },
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
    expect({ started, finished }).toStrictEqual({ started: ["2"], finished: [] });

    release.resolve();
    await Promise.all([overflow, buffered, debouncer.drain()]);
    expect({ started, finished }).toStrictEqual({ started: ["2", "3"], finished: ["2", "3"] });
  });

  it("counts tracked debounce keys by union of buffers and active chains", async () => {
    const { debouncer, started, finished, entered, release } = createBlockedDebouncer(
      { maxTrackedKeys: 3 },
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
    expect({ started, finished }).toStrictEqual({ started: ["2", "4"], finished: ["4"] });

    release.resolve();
    await secondFlush;
    expect(finished).toEqual(["4", "2"]);
    debouncer.cancelKey("a");
    debouncer.cancelKey("c");
    await debouncer.drain();
  });
});
