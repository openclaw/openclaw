import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { responseWithRelease } from "./fetch-runtime.js";

function readerWithRelease(body: BodyInit, release: () => Promise<void>) {
  return responseWithRelease(new Response(body), release).body!.getReader();
}

function settlement(promise: Promise<unknown>) {
  return Promise.race([promise.then(() => "settled"), setImmediate("pending")]);
}
afterEach(() => vi.restoreAllMocks());
it.each(["throw", "reject"] as const)(
  "reports null-body response release failures (%s) without an unhandled rejection",
  async (failureMode) => {
    const failure = new Error("request ownership release failed");
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const release = vi.fn(() => {
      if (failureMode === "throw") {
        throw failure;
      }
      return Promise.reject(failure);
    });
    const response = new Response(null, { status: 204 });
    expect(responseWithRelease(response, release)).toBe(response);
    await setImmediate();
    expect(warning).toHaveBeenCalledExactlyOnceWith(failure);
  },
);

it("closes downstream EOF before awaiting release", async () => {
  const releaseGate = createDeferred();
  const releaseFinished = createDeferred();
  const reader = readerWithRelease("complete", async () => {
    await releaseGate.promise;
    releaseFinished.resolve();
  });
  await expect(reader.read()).resolves.toMatchObject({ done: false });
  const eof = reader.read();
  await expect(settlement(eof)).resolves.toBe("settled");
  await expect(eof).resolves.toEqual({ done: true, value: undefined });
  releaseGate.resolve();
  await releaseFinished.promise;
});

it.each([false, true])(
  "awaits cancellation and release despite upstream failure=%s",
  async (fails) => {
    const pullStarted = createDeferred();
    const cancelGate = createDeferred();
    const releaseGate = createDeferred();
    const release = vi.fn(async () => await releaseGate.promise);
    const reason = new Error("consumer stopped");
    const upstreamCancel = vi.fn(async () => {
      await cancelGate.promise;
      if (fails) {
        throw new Error("upstream cancellation failed");
      }
    });
    const reader = readerWithRelease(
      new ReadableStream<Uint8Array>({
        pull: () => pullStarted.resolve(),
        cancel: upstreamCancel,
      }),
      release,
    );
    const read = reader.read();
    await pullStarted.promise;
    const cancellation = reader.cancel(reason);
    try {
      await expect(settlement(cancellation)).resolves.toBe("pending");
      expect(upstreamCancel).toHaveBeenCalledWith(reason);
      expect(release).toHaveBeenCalledTimes(1);
      cancelGate.resolve();
      await expect(settlement(cancellation)).resolves.toBe("pending");
    } finally {
      cancelGate.resolve();
      releaseGate.resolve();
      await cancellation;
      reader.releaseLock();
    }
    await expect(read).resolves.toEqual({ done: true, value: undefined });
  },
);

it("releases a cancelled response before its capture tee settles", async () => {
  const sourceCancel = vi.fn();
  const response = new Response(new ReadableStream<Uint8Array>({ cancel: sourceCancel }));
  const capture = response.clone();
  const release = vi.fn(async () => await capture.body?.cancel("capture stopped"));
  const cancellation = responseWithRelease(response, release).body!.cancel("consumer stopped");
  try {
    await expect(settlement(cancellation)).resolves.toBe("settled");
    expect(release).toHaveBeenCalledTimes(1);
    expect(sourceCancel).toHaveBeenCalledTimes(1);
    expect(response.body?.locked).toBe(false);
  } finally {
    await capture.body?.cancel("test cleanup");
    await cancellation;
  }
});
