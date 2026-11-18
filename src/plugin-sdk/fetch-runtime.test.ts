import { setImmediate } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { responseWithRelease } from "./fetch-runtime.js";

const settlement = (promise: Promise<unknown>) =>
  Promise.race([promise.then(() => "settled"), setImmediate("pending")]);
afterEach(() => vi.restoreAllMocks());
it.each(["throw", "reject"] as const)("reports null-body release failure: %s", async (mode) => {
  const failure = new Error("request ownership release failed");
  const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  const release = vi.fn(() => {
    if (mode === "throw") {
      throw failure;
    }
    return Promise.reject(failure);
  });
  const response = new Response(null, { status: 204 });
  expect(responseWithRelease(response, release)).toBe(response);
  await setImmediate();
  expect(warning).toHaveBeenCalledExactlyOnceWith(failure);
});

it("preserves metadata and closes EOF before release", async () => {
  const uri = "data:,complete";
  const original = await fetch(uri);
  Object.defineProperty(original, "redirected", { value: true });
  const releaseGate = createDeferred();
  const release = vi.fn(() => releaseGate.promise);
  const wrapped = responseWithRelease(original, release);
  const clone = wrapped.clone();
  const deepClone = clone.clone();
  const expected = { url: uri, redirected: true, type: original.type, status: 200 };
  for (const response of [wrapped, clone, deepClone]) {
    expect(response).toMatchObject(expected);
  }
  clone.headers.set("x-response", "clone");
  wrapped.headers.set("x-response", "wrapped");
  expect(original.headers.get("x-response")).toBeNull();
  expect(clone.headers.get("x-response")).toBe("clone");
  const reader = wrapped.body!.getReader();
  await expect(reader.read()).resolves.toMatchObject({ done: false });
  const eof = reader.read();
  await expect(settlement(eof)).resolves.toBe("settled");
  await expect(eof).resolves.toEqual({ done: true, value: undefined });
  expect(release).toHaveBeenCalledTimes(1);
  releaseGate.resolve();
  await release.mock.results[0]!.value;
  const bodies = await Promise.all([clone.text(), deepClone.text()]);
  expect(bodies).toEqual(["complete", "complete"]);
});

it.each([false, true])("awaits cancellation and release (failure=%s)", async (fails) => {
  const cancelGate = createDeferred();
  const releaseGate = createDeferred();
  const release = vi.fn(() => releaseGate.promise);
  const reason = new Error("consumer stopped");
  const cancel = vi.fn(async () => {
    await cancelGate.promise;
    if (fails) {
      throw new Error("upstream cancellation failed");
    }
  });
  const upstream = new Response(new ReadableStream<Uint8Array>({ cancel }));
  const reader = responseWithRelease(upstream, release).body!.getReader();
  const read = reader.read();
  const cancellation = reader.cancel(reason);
  try {
    await expect(settlement(cancellation)).resolves.toBe("pending");
    expect(cancel).toHaveBeenCalledWith(reason);
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
});

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
