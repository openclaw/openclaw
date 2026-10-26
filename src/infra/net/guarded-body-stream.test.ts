import { setImmediate as nextTurn } from "node:timers/promises";
import { promiseHooks, queryObjects } from "node:v8";
import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { readResponseWithLimit } from "../http-body.js";
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
  const modes = ["prefetched", "unread", "partial"] as const;
  const abandoned = await Promise.all(modes.map(abandon));
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
  const cleanup = vi.fn(() => {
    order.push("cleanup");
    started.resolve();
    return fails ? released.promise : released.resolve();
  });
  const wrapped = wrapGuardedBodyStream({ body: source, cleanup });
  const settled = vi.fn();
  const operation = wrapped
    .cancel(reason)
    .catch((error: unknown) => error)
    .finally(settled);
  try {
    await started.promise;
    await nextTurn();
    expect(settled).toHaveBeenCalledTimes(fails ? 0 : 1);
    expect(order).toEqual([reason, "cleanup"]);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(source.locked).toBe(false);
  } finally {
    released.resolve();
    await expect(operation).resolves.toBe(fails ? failure : undefined);
  }
});

it.each(["read", "refresh"])(
  "releases the source reader lock while preserving a %s failure",
  async (failureSource) => {
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
  },
);
it("preserves response metadata across clones", async () => {
  const source = new Response("payload");
  Object.defineProperties(source, {
    url: { value: "https://test/final" },
    redirected: { value: true },
    type: { value: "cors" },
  });
  const wrapped = responseWithAbortSignal(source, new AbortController().signal);
  const clone = wrapped.clone();

  expect(clone).toMatchObject({ url: "https://test/final", redirected: true, type: "cors" });
  expect((await readResponseWithLimit(clone, 32)).toString("utf8")).toBe("payload");
  await wrapped.body?.cancel();
});

it("attaches the abort listener only when body consumption starts", async () => {
  const controller = new AbortController();
  const addEventListener = vi.spyOn(controller.signal, "addEventListener");
  const source = new Response(new ReadableStream<Uint8Array>());
  const wrapped = responseWithAbortSignal(source, controller.signal);

  expect(addEventListener).not.toHaveBeenCalled();
  const reader = wrapped.body!.getReader();
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
  "forwards 1,000 chunks without an extra async promise per pull",
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
    const reader = wrapGuardedBodyStream({
      body,
      refreshTimeout: () => refreshed++,
      cleanup: () => {
        released++;
      },
    }).getReader();
    let promises = 0;
    let received = 0;
    let identical = true;
    const stop = promiseHooks.createHook({ init: () => promises++ });
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) {
          break;
        }
        identical &&= next.value === chunk;
        received++;
      }
    } finally {
      stop();
      reader.releaseLock();
    }
    expect({ received, refreshed, released, identical }).toEqual({
      received: 1_000,
      refreshed: 1_000,
      released: 1,
      identical: true,
    });
    // Six promises per chunk include source/consumer reads and stream backpressure.
    // Leave room for fixed setup/EOF work, but reject another promise per chunk.
    expect(promises).toBeLessThan(6_100);
  },
);
