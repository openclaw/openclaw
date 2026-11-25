import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createAwaitedDecodedOutput, joinProcessCompletionAndOutput } from "./decoded-output.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

function fixture(onFailure = vi.fn<(error: unknown) => void>(), alreadyClosed = false) {
  const source = new PassThrough();
  if (alreadyClosed) {
    source.destroy();
  }
  const output = createAwaitedDecodedOutput(source, onFailure);
  const releases: (() => void)[] = [];
  cleanups.push(async () => {
    releases.forEach((release) => release());
    output.close();
    source.destroy();
    await output.drain().catch(() => undefined);
  });
  return {
    source,
    output,
    onFailure,
    gate() {
      const gate = createDeferred();
      releases.push(() => gate.resolve());
      return gate;
    },
  };
}

async function expectPending(promise: Promise<unknown>) {
  const settled = vi.fn();
  void promise.then(settled, settled);
  await Promise.resolve();
  expect(settled).not.toHaveBeenCalled();
}

function pausedConsumer() {
  const state = fixture();
  const entered = createDeferred();
  const release = state.gate();
  const chunks: string[] = [];
  const consumed = state.output.consume(async (chunk) => {
    chunks.push(chunk);
    if (chunks.length === 1) {
      entered.resolve();
      await release.promise;
    }
  });
  return { ...state, entered, release, chunks, consumed };
}

it("retains stdout when the source resumes and ends before subscription", async () => {
  const { source, output } = fixture();
  source.end("output before subscription");
  source.resume();
  await finished(source);
  let received = "";
  await output.consume((chunk) => {
    received += chunk;
  });
  expect(received).toBe("output before subscription");
});

it("rejects a source already closed before subscription", async () => {
  const { output, onFailure } = fixture(undefined, true);
  const consumed = output.consume(() => {});
  await expect(consumed).rejects.toThrow("Process stdout closed before EOF");
  expect(onFailure.mock.calls[0]?.[0]).toEqual(new Error("Process stdout closed before EOF"));
});

it("requests stop for a rejected consumer and joins native completion before rejecting", async () => {
  const stopped = createDeferred<unknown>();
  const completion = createDeferred<{ code: number }>();
  const failure = new Error("synthetic rejected consumer");
  const { source, output, onFailure } = fixture(vi.fn((error) => stopped.resolve(error)));
  const consumed = output.consume(async () => {
    throw failure;
  });
  const joined = joinProcessCompletionAndOutput(completion.promise, consumed);
  try {
    source.write("input");
    expect(await stopped.promise).toBe(failure);
    source.end("discard after stop");
    await finished(source);
    await consumed.catch(() => undefined);
    await expectPending(joined);
    completion.resolve({ code: 0 });
    await expect(joined).rejects.toBe(failure);
    expect(onFailure).toHaveBeenCalledTimes(1);
  } finally {
    completion.resolve({ code: 0 });
    output.close();
    source.destroy();
    await joined.catch(() => undefined);
  }
});

it("keeps native backpressure and ordered delivery while consumption waits", async () => {
  const { source, output, entered, release, chunks, consumed } = pausedConsumer();
  source.write("first");
  await entered.promise;
  const remaining = "x".repeat(source.writableHighWaterMark);
  source.write(remaining);
  expect(source.write(remaining)).toBe(false);
  source.end();
  expect(output.drain()).toBe(consumed);
  expect(chunks).toEqual(["first"]);
  await expectPending(consumed);
  release.resolve();
  await consumed;
  expect(chunks.join("")).toBe(`first${remaining}${remaining}`);
});

it("joins the decoder tail consumer after source EOF", async () => {
  const { source, entered, release, chunks, consumed } = pausedConsumer();
  source.write(Buffer.from([0xf0]));
  source.end(Buffer.from([0x9f]));
  await entered.promise;
  expect(chunks).toEqual(["�"]);
  await expectPending(consumed);
  release.resolve();
  await consumed;
});

it("rejects disposal after EOF while the sink finish event is queued", async () => {
  const { source, output, onFailure } = fixture();
  const firstChunk = createDeferred();
  const consumed = output.consume(async () => {
    await Promise.resolve();
    firstChunk.resolve();
  });
  source.write("accepted");
  await firstChunk.promise;
  source.end();
  await finished(source);
  // Let the async final callback queue finish before disposal queues its error.
  await Promise.resolve();
  output.close();
  await expect(consumed).rejects.toThrow("Process stdout consumption closed");
  expect(onFailure).not.toHaveBeenCalled();
});
