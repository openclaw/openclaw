import { setImmediate as waitForImmediate } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { createBoundedProviderBinaryStream } from "./provider-binary-stream.js";

function bound(
  source: ReadableStream<Uint8Array>,
  cleanup: () => Promise<void>,
  overrides: Partial<Omit<Parameters<typeof createBoundedProviderBinaryStream>[1], "cleanup">> = {},
  gates: Array<{ resolve(value: void): void }> = [],
) {
  const bounded = createBoundedProviderBinaryStream(source, {
    maxBytes: 8,
    createOverflowError: () => new Error("overflow"),
    createReleaseError: () => new Error("released"),
    ...overrides,
    cleanup,
  });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  return {
    ...bounded,
    read: () => (reader ??= bounded.stream.getReader()).read(),
    async [Symbol.asyncDispose]() {
      for (const gate of gates) {
        gate.resolve();
      }
      reader?.releaseLock();
      await bounded.release().catch(() => undefined);
    },
  };
}

function track<T>(work: Promise<T>) {
  const state = { settled: false };
  const result = work.finally(() => {
    state.settled = true;
  });
  void result.catch(() => undefined);
  return { state, result };
}
function bytesSource(cancel: UnderlyingSource<Uint8Array>["cancel"]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.from([1, 2, 3, 4, 5]));
    },
    cancel,
  });
}
const fulfilled = { status: "fulfilled", value: undefined };
const rejected = (reason: Error) => ({ status: "rejected", reason });

it("shares finalization when source cancellation reenters release", async () => {
  const reentered: Promise<void>[] = [];
  const cancel = vi.fn(() => {
    reentered.push(bounded.release());
  });
  const cleanup = vi.fn(async () => {});
  const source = new ReadableStream<Uint8Array>({ cancel });
  await using bounded = bound(source, cleanup);
  await bounded.release();
  await Promise.all(reentered);
  expect(cancel).toHaveBeenCalledOnce();
  expect(cleanup).toHaveBeenCalledOnce();
  expect(source.locked).toBe(false);
});

it.each(["eof", "error"] as const)("%s unlocks without request cleanup", async (ending) => {
  const failure = new Error("read failed");
  const cancel = vi.fn();
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      if (ending === "eof") {
        controller.close();
      } else {
        controller.error(failure);
      }
    },
    cancel,
  });
  const cleanup = vi.fn(async () => {});
  await using bounded = bound(source, cleanup);

  if (ending === "eof") {
    await expect(bounded.read()).resolves.toEqual({ done: true, value: undefined });
  } else {
    await expect(bounded.read()).rejects.toBe(failure);
  }
  expect(source.locked).toBe(false);
  expect(cleanup).not.toHaveBeenCalled();
  await bounded.release();
  await bounded.release();
  expect(cleanup).toHaveBeenCalledOnce();
  expect(cancel).not.toHaveBeenCalled();
});

it.each(
  (["cancel", "release"] as const).flatMap((first) =>
    ["success", "cancel-error", "cleanup-error"].map((outcome) => ({ first, outcome })),
  ),
)("$first first, $outcome: awaits and shares finalization", async ({ first, outcome }) => {
  const canceled = createDeferredCore();
  const cleaned = createDeferredCore();
  const reason = new Error("stop playback");
  const cancelError = new Error("source cancellation failed");
  const cleanupError = new Error("request cleanup failed");
  const cancel = vi.fn(() => canceled.promise);
  const source = new ReadableStream<Uint8Array>({ cancel });
  const cleanup = vi.fn(async () => {
    expect(cancel).toHaveBeenCalledExactlyOnceWith(reason);
    expect(source.locked).toBe(false);
    await cleaned.promise;
  });
  await using bounded = bound(source, cleanup, { createReleaseError: () => reason }, [
    canceled,
    cleaned,
  ]);
  const earlyCancel = first === "cancel" ? bounded.stream.cancel(reason) : undefined;
  const pendingRelease = track(bounded.release());
  const pendingCancel = track(earlyCancel ?? bounded.stream.cancel(reason));
  const pending = Promise.allSettled([pendingCancel.result, pendingRelease.result]);
  const expectPending = () =>
    expect([pendingCancel.state.settled, pendingRelease.state.settled]).toEqual([false, false]);
  await waitForImmediate();
  expectPending();
  if (outcome === "success") {
    canceled.resolve();
  } else {
    canceled.reject(cancelError);
  }
  await waitForImmediate();
  expectPending();
  if (outcome === "cleanup-error") {
    cleaned.reject(cleanupError);
  } else {
    cleaned.resolve();
  }
  const [cancellation, release] = await pending;
  expect(cancellation).toEqual(
    outcome === "success"
      ? fulfilled
      : rejected(outcome === "cleanup-error" ? cleanupError : cancelError),
  );
  expect(release).toEqual(outcome === "cleanup-error" ? rejected(cleanupError) : fulfilled);
  await bounded.release().catch(() => undefined);
  expect(cancel).toHaveBeenCalledExactlyOnceWith(reason);
  expect(cleanup).toHaveBeenCalledOnce();
});

it("delivers overflow before delayed cleanup and preserves its later release failure", async () => {
  const cleaned = createDeferredCore();
  const overflow = new Error("overflow");
  const cleanupError = new Error("request cleanup failed");
  const source = bytesSource(async () => {
    throw new Error("best-effort source cancellation failed");
  });
  const cleanup = vi.fn(() => cleaned.promise);
  await using bounded = bound(
    source,
    cleanup,
    { maxBytes: 4, createOverflowError: () => overflow },
    [cleaned],
  );

  await expect(bounded.read()).resolves.toEqual({
    done: false,
    value: Uint8Array.from([1, 2, 3, 4]),
  });
  await expect(bounded.read()).rejects.toBe(overflow);
  expect(cleanup).toHaveBeenCalledOnce();
  const pending = track(bounded.release());
  await waitForImmediate();
  expect(pending.state.settled).toBe(false);
  cleaned.reject(cleanupError);
  await expect(pending.result).rejects.toBe(cleanupError);
  expect(source.locked).toBe(false);
});

it.each(["release", "overflow"] as const)(
  "%s cleanup cancels retained response clones",
  async (kind) => {
    const cancel = vi.fn();
    const response = new Response(bytesSource(cancel));
    const capture = response.clone();
    const expected = new Error(kind);
    const cleanup = vi.fn(async () => {
      await capture.body?.cancel();
    });
    await using bounded = bound(response.body!, cleanup, {
      maxBytes: kind === "overflow" ? 4 : 8,
      createOverflowError: () => expected,
      createReleaseError: () => expected,
    });
    const operation = (async () => {
      const first = await bounded.read();
      if (kind === "overflow") {
        await expect(bounded.read()).rejects.toBe(expected);
      } else {
        expect(first).toEqual({ done: false, value: Uint8Array.from([1, 2, 3, 4, 5]) });
      }
      await bounded.release();
      return true;
    })();
    try {
      expect(await Promise.race([operation, waitForImmediate()])).toBe(true);
      expect(response.body?.locked).toBe(false);
      expect(cleanup).toHaveBeenCalledOnce();
    } finally {
      await capture.body?.cancel();
      await operation;
    }
    expect(cancel).toHaveBeenCalledExactlyOnceWith([expected, undefined]);
  },
);
