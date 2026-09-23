import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { readResponseWithLimit } from "../http-body.js";
import { responseWithAbortSignal, wrapGuardedBodyStream } from "./guarded-body-stream.js";

describe("wrapGuardedBodyStream", () => {
  it("releases the source reader lock after downstream cancellation", async () => {
    const cancel = vi.fn();
    const cleanup = vi.fn();
    const source = new ReadableStream<Uint8Array>({ cancel });
    const wrapped = wrapGuardedBodyStream({ body: source, cleanup });

    expect(source.locked).toBe(true);
    await wrapped.cancel("consumer stopped");

    expect(cancel).toHaveBeenCalledExactlyOnceWith("consumer stopped");
    expect(cleanup).toHaveBeenCalledOnce();
    expect(source.locked).toBe(false);
  });

  it("propagates downstream cancellation failure after releasing resources", async () => {
    const expected = new Error("source cancellation failed");
    const started = createDeferredCore();
    const released = createDeferredCore();
    const cleanup = vi.fn(() => {
      started.resolve();
      return released.promise;
    });
    const source = new ReadableStream<Uint8Array>({
      async cancel() {
        throw expected;
      },
    });
    const wrapped = wrapGuardedBodyStream({ body: source, cleanup });

    let settled = false;
    const operation = wrapped
      .cancel("consumer stopped")
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    try {
      await started.promise;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(settled).toBe(false);
      expect(cleanup).toHaveBeenCalledOnce();
      expect(source.locked).toBe(false);
    } finally {
      released.resolve();
    }
    await expect(operation).resolves.toBe(expected);
  });

  it("runs owner cleanup before awaiting upstream cancellation", async () => {
    const released = createDeferredCore();
    const order: unknown[] = [];
    const cancel = vi.fn((reason: unknown) => {
      order.push(reason);
      return released.promise;
    });
    const source = new ReadableStream<Uint8Array>({ cancel });
    const reason = new Error("consumer stopped");
    const cleanup = vi.fn(() => {
      order.push("cleanup");
      released.resolve();
    });
    const wrapped = wrapGuardedBodyStream({ body: source, cleanup });
    const operation = wrapped.cancel(reason);
    try {
      const completed = await Promise.race([
        operation.then(() => true),
        new Promise<boolean>((resolve) => {
          setImmediate(() => resolve(false));
        }),
      ]);
      expect(completed).toBe(true);
      expect(order).toEqual([reason, "cleanup"]);
      expect(cleanup).toHaveBeenCalledOnce();
      expect(source.locked).toBe(false);
    } finally {
      released.resolve();
      await operation;
    }
  });

  it("releases the source reader lock after normal completion", async () => {
    const cleanup = vi.fn();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("done"));
        controller.close();
      },
    });
    const wrapped = wrapGuardedBodyStream({ body: source, cleanup });
    const reader = wrapped.getReader();

    const chunk = await reader.read();
    expect(new TextDecoder().decode(chunk.value)).toBe("done");
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    reader.releaseLock();

    expect(cleanup).toHaveBeenCalledOnce();
    expect(source.locked).toBe(false);
  });

  it("releases the source reader lock while preserving a read failure", async () => {
    const expected = new Error("source read failed");
    const cleanup = vi.fn();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(expected);
      },
    });
    const wrapped = wrapGuardedBodyStream({ body: source, cleanup });
    const reader = wrapped.getReader();

    await expect(reader.read()).rejects.toBe(expected);
    reader.releaseLock();

    expect(cleanup).toHaveBeenCalledOnce();
    expect(source.locked).toBe(false);
  });
});

describe("responseWithAbortSignal", () => {
  it("preserves response metadata across clones", async () => {
    const source = new Response("payload");
    Object.defineProperties(source, {
      url: { value: "https://example.test/final" },
      redirected: { value: true },
      type: { value: "cors" },
    });
    const wrapped = responseWithAbortSignal(source, new AbortController().signal);
    const clone = wrapped.clone();

    expect(clone.url).toBe("https://example.test/final");
    expect(clone.redirected).toBe(true);
    expect(clone.type).toBe("cors");
    expect((await readResponseWithLimit(clone, 32)).toString("utf8")).toBe("payload");
    await wrapped.body?.cancel();
  });

  it("attaches the abort listener only when body consumption starts", async () => {
    const controller = new AbortController();
    const addEventListener = vi.spyOn(controller.signal, "addEventListener");
    const wrapped = responseWithAbortSignal(
      new Response(new ReadableStream<Uint8Array>()),
      controller.signal,
    );

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
});
