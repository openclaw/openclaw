import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { responseWithRelease } from "./fetch-runtime.js";

function getReader(response: Response) {
  if (!response.body) {
    throw new Error("expected wrapped response body");
  }
  return response.body.getReader();
}

describe("plugin SDK fetch runtime", () => {
  it("closes downstream EOF before awaiting release", async () => {
    const releaseGate = createDeferred();
    const releaseFinished = createDeferred();
    const wrapped = responseWithRelease(new Response("complete"), async () => {
      await releaseGate.promise;
      releaseFinished.resolve();
    });
    const reader = getReader(wrapped);

    await expect(reader.read()).resolves.toMatchObject({ done: false });
    const eof = reader.read();
    let eofSettled = false;
    void eof.then(() => {
      eofSettled = true;
    });
    await setImmediate();

    expect(eofSettled).toBe(true);
    await expect(eof).resolves.toEqual({ done: true, value: undefined });
    releaseGate.resolve();
    await releaseFinished.promise;
  });

  it("awaits both upstream cancellation and owner release", async () => {
    const pullStarted = createDeferred();
    const cancelGate = createDeferred();
    const releaseGate = createDeferred();
    const release = vi.fn(async () => await releaseGate.promise);
    const reason = new Error("consumer stopped");
    const upstreamCancel = vi.fn(async () => await cancelGate.promise);
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          pullStarted.resolve();
        },
        cancel: upstreamCancel,
      }),
    );
    const wrapped = responseWithRelease(response, release);
    const reader = getReader(wrapped);
    const read = reader.read();
    await pullStarted.promise;

    let settled = false;
    const cancellation = reader.cancel(reason).finally(() => {
      settled = true;
    });
    try {
      await setImmediate();
      expect(upstreamCancel).toHaveBeenCalledWith(reason);
      expect(release).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      cancelGate.resolve();
      await setImmediate();
      expect(settled).toBe(false);
    } finally {
      cancelGate.resolve();
      releaseGate.resolve();
      await cancellation;
      reader.releaseLock();
    }
    await expect(read).resolves.toEqual({ done: true, value: undefined });
  });

  it("releases a cancelled response before its capture tee settles", async () => {
    const sourceCancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel: sourceCancel }));
    const capture = response.clone();
    const release = vi.fn(async () => await capture.body?.cancel("capture stopped"));
    const wrapped = responseWithRelease(response, release);
    let settled = false;
    const cancellation = wrapped.body?.cancel("consumer stopped").then(() => {
      settled = true;
    });
    try {
      await setImmediate();
      expect(release).toHaveBeenCalledTimes(1);
      expect(sourceCancel).toHaveBeenCalledTimes(1);
      expect(settled).toBe(true);
      expect(response.body?.locked).toBe(false);
    } finally {
      await capture.body?.cancel("test cleanup");
      await cancellation;
    }
  });

  it("settles cancellation after release when upstream cancellation fails", async () => {
    const source = new ReadableStream<Uint8Array>({
      cancel() {
        throw new Error("upstream cancellation failed");
      },
    });
    const release = vi.fn(async () => {});
    const wrapped = responseWithRelease(new Response(source), release);

    await expect(wrapped.body?.cancel()).resolves.toBeUndefined();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
