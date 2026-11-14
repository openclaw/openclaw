import { setImmediate as nextTurn } from "node:timers/promises";
import { promiseHooks, queryObjects } from "node:v8";
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { makeStallingStream } from "../http-body.test-support.js";
import { responseWithAbortSignal, wrapGuardedBodyStream } from "./guarded-body-stream.js";

it("releases abandoned bodies before and after attaching their abort listener", async () => {
  const signal = new AbortController().signal;
  async function abandon(mode: "prefetched" | "unread" | "partial") {
    const cleaned = createDeferredCore();
    const cancel = vi.fn();
    const source = makeStallingStream([new Uint8Array([1])], cancel);
    const wrapped = wrapGuardedBodyStream({
      body: source,
      cleanup: cleaned.resolve,
      signal: mode === "prefetched" ? undefined : signal,
    });
    if (mode === "partial") {
      const reader = wrapped.getReader();
      expect((await reader.read()).value).toEqual(new Uint8Array([1]));
      reader.releaseLock();
    }
    return { reference: new WeakRef(wrapped), source, cancel, cleaned: cleaned.promise };
  }
  const abandoned = await Promise.all((["prefetched", "unread", "partial"] as const).map(abandon));
  const control = new WeakRef({});
  // End the creation job before collecting; the signal and upstream bodies stay live.
  await nextTurn();
  queryObjects(WeakRef);
  expect(control.deref()).toBeUndefined();
  for (const body of abandoned) {
    expect(body.reference.deref()).toBeUndefined();
  }
  await Promise.all(abandoned.map((body) => body.cleaned));
  for (const body of abandoned) {
    expect(body.source.locked).toBe(false);
    expect(body.cancel).toHaveBeenCalledOnce();
  }
  expect(signal.aborted).toBe(false);
});

it.each([true, false])("releases cancellation resources (upstream failure=%s)", async (fails) => {
  const failure = new Error("source cancellation failed");
  const reason = new Error("consumer stopped");
  const released = createDeferredCore();
  const started = createDeferredCore();
  const order: unknown[] = [];
  const source = new ReadableStream<Uint8Array>({
    cancel(value) {
      order.push(value);
      return fails ? Promise.reject(failure) : released.promise;
    },
  });
  const cleanup = () => {
    order.push("cleanup");
    started.resolve();
    return fails ? released.promise : released.resolve();
  };
  const settled = vi.fn();
  const operation = wrapGuardedBodyStream({ body: source, cleanup })
    .cancel(reason)
    .catch((error: unknown) => error)
    .finally(settled);
  try {
    await started.promise;
    await nextTurn();
    expect(settled).toHaveBeenCalledTimes(fails ? 0 : 1);
    expect(order).toEqual([reason, "cleanup"]);
    expect(source.locked).toBe(false);
  } finally {
    released.resolve();
    await expect(operation).resolves.toBe(fails ? failure : undefined);
  }
});

it.each(["read", "refresh"])("releases the reader on %s failure", async (failureSource) => {
  const expected = new Error("source read failed");
  const cleanup = vi.fn();
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      if (failureSource === "read") {
        controller.error(expected);
      } else {
        controller.enqueue(new Uint8Array([1]));
      }
    },
  });
  const wrapped = wrapGuardedBodyStream({
    body: source,
    cleanup,
    refreshTimeout() {
      throw expected;
    },
  });
  const reader = wrapped.getReader();

  await expect(reader.read()).rejects.toBe(expected);
  reader.releaseLock();
  expect(cleanup).toHaveBeenCalledOnce();
  expect(source.locked).toBe(false);
});
it("preserves clone metadata and lazy abort propagation", async () => {
  const controller = new AbortController();
  const addEventListener = vi.spyOn(controller.signal, "addEventListener");
  const source = new Response(new ReadableStream<Uint8Array>());
  Object.defineProperties(source, {
    url: { value: "https://test/final" },
    redirected: { value: true },
    type: { value: "cors" },
  });
  const wrapped = responseWithAbortSignal(source, controller.signal);
  expect(addEventListener).not.toHaveBeenCalled();
  const clone = wrapped.clone();
  expect(clone).toMatchObject({ url: "https://test/final", redirected: true, type: "cors" });
  const reader = clone.body!.getReader();
  const read = reader.read();
  await vi.waitFor(() =>
    expect(addEventListener).toHaveBeenCalledWith("abort", expect.any(Function), { once: true }),
  );
  const reason = new Error("caller stopped");
  controller.abort(reason);
  await expect(read).rejects.toBe(reason);
  reader.releaseLock();
});

// Bun does not implement V8 promise hooks; the lifecycle tests above still run there.
it.skipIf(Boolean(process.versions.bun))(
  "forwards 1,000 chunks without per-chunk continuations or an extra async promise",
  async () => {
    const chunk = new Uint8Array([1, 2, 3]);
    let sent = 0;
    let refreshed = 0;
    let released = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < 1_000) {
          controller.enqueue(chunk);
        } else {
          controller.close();
        }
      },
    });
    const upstream = body.getReader();
    const read = upstream.read.bind(upstream);
    const continuations = new Set<unknown>();
    vi.spyOn(body, "getReader").mockReturnValue(upstream);
    upstream.read = () => {
      const pending = read();
      const then = pending.then.bind(pending);
      // Observe allocation work at the actual upstream read boundary, forwarding
      // the original promise and handlers without replacing stream behavior.
      // oxlint-disable-next-line unicorn/no-thenable -- This is already a Promise; spies add settlement promises.
      pending.then = (fulfilled, rejected) => {
        if (fulfilled) {
          continuations.add(fulfilled);
        }
        if (rejected) {
          continuations.add(rejected);
        }
        return then(fulfilled, rejected);
      };
      return pending;
    };
    const reader = wrapGuardedBodyStream({
      body,
      refreshTimeout: () => refreshed++,
      cleanup: () => void released++,
    }).getReader();
    let promises = 0;
    let received = 0;
    let identical = true;
    const stop = promiseHooks.createHook({ init: () => promises++ });
    try {
      for (let next = await reader.read(); !next.done; next = await reader.read()) {
        identical &&= next.value === chunk;
        received++;
      }
    } finally {
      stop();
      reader.releaseLock();
    }
    expect(received).toBe(1_000);
    expect(refreshed).toBe(1_000);
    expect(released).toBe(1);
    expect(identical).toBe(true);
    // Six promises per chunk include source/consumer reads and stream backpressure.
    // Leave room for fixed setup/EOF work, but reject another promise per chunk.
    expect(promises).toBeLessThan(6_100);
    expect(continuations.size).toBeLessThanOrEqual(2);
  },
);
