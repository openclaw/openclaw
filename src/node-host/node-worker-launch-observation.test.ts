import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred, nextEventLoopTurn } from "../../test/helpers/promise.js";
import { createEnteredGate } from "../agents/entered-gate.test-support.js";
import { createAwaitedDecodedOutput, onDecodedOutput } from "../process/decoded-output.js";
import type { ProcessExtinctionResult } from "../process/supervisor/types.js";
import type {
  WorkerProcessMessage,
  WorkerProcessResult,
} from "../worker/worker-process-protocol.js";
import {
  observeNodeWorkerChild,
  type NodeWorkerTerminalOutcome,
} from "./node-worker-launch-observation.js";
import type { NodeWorkerChildAdapter } from "./node-worker-launch-transport.js";
import {
  createNodeWorkerCredentialScrubber,
  NODE_WORKER_STDOUT_MAX_BYTES,
} from "./node-worker-output.js";

function resultFrame(turnId: string, transcriptLeafId = "leaf") {
  return {
    type: "result",
    turnId,
    result: { status: "completed", transcriptLeafId, transcriptNextSeq: 2 },
    retainWorker: false,
  } satisfies WorkerProcessResult;
}

function encodeResult(turnId: string, transcriptLeafId = "leaf"): Buffer {
  return Buffer.from(`${JSON.stringify(resultFrame(turnId, transcriptLeafId))}\n`);
}

function sizedResult(turnId: string, bytes: number): Buffer {
  return encodeResult(turnId, "x".repeat(bytes - encodeResult(turnId, "").length));
}

const completed = (result: WorkerProcessResult["result"] = resultFrame("first").result) => ({
  state: "completed",
  resultJson: JSON.stringify(result),
});
const overflow = {
  state: "failed",
  errorText: `worker stdout exceeded ${NODE_WORKER_STDOUT_MAX_BYTES} bytes`,
};

function observationHarness(
  options: {
    waitForExtinction?: NodeWorkerChildAdapter["waitForExtinction"];
    cleanupContainer?: () => Promise<void>;
    expectedKind?: "confirmed" | "deferred";
    consumeError?: Error;
    onResult?: (frame: WorkerProcessMessage) => Promise<void>;
    onFinish?: () => void;
  } = {},
) {
  const stdout = new PassThrough();
  const consumption = createAwaitedDecodedOutput(stdout, () => kill("SIGKILL"));
  const stderr = new PassThrough();
  const journal = createDeferred();
  const exit = createDeferred<{ code: number | null; signal: NodeJS.Signals | null }>();
  const stopped = createDeferred();
  const firstChunkConsumed = createDeferred();
  const unsubscribe: Array<() => void> = [];
  const kill = vi.fn((_signal?: NodeJS.Signals) => stopped.resolve());
  const dispose = () => {
    consumption.close();
    for (const stop of unsubscribe) {
      stop();
    }
    stdout.destroy();
    stderr.destroy();
  };
  const adapter = {
    supportsRawOutput: true,
    onStdout: (listener, onRaw) => {
      unsubscribe.push(onDecodedOutput(stdout, listener, onRaw));
    },
    consumeStdout: (listener) =>
      consumption.consume(async (chunk) => {
        if (options.consumeError) {
          throw options.consumeError;
        }
        await listener(chunk);
        firstChunkConsumed.resolve();
      }),
    onStderr: (listener, onRaw) => {
      unsubscribe.push(onDecodedOutput(stderr, listener, onRaw));
    },
    onExit: () => {},
    onError: () => {},
    wait: () => exit.promise,
    waitForExtinction: options.waitForExtinction,
    kill,
    dispose,
  } satisfies NodeWorkerChildAdapter;
  const frames: WorkerProcessMessage[] = [];
  const completion = observeNodeWorkerChild(
    {
      adapter,
      journalReady: journal.promise,
      scrubber: createNodeWorkerCredentialScrubber("framing-fixture-token"),
      connectionFailure: {},
    },
    async (frame) => {
      frames.push(frame);
      await options.onResult?.(frame);
    },
    () => undefined,
    options.cleanupContainer,
  );
  const outcome = completion.then((observation) => {
    expect(observation.kind).toBe(options.expectedKind ?? "confirmed");
    return observation.outcome;
  });
  let closing: Promise<NodeWorkerTerminalOutcome> | undefined;
  const close = () =>
    (closing ??= (async () => {
      stdout.end();
      stderr.end();
      // The outcome owns output errors; cleanup joins EOF and the decoder's final callback.
      await Promise.allSettled([finished(stdout), finished(stderr), consumption.drain()]);
      journal.resolve();
      exit.resolve({ code: 0, signal: null });
      return outcome.finally(dispose);
    })());
  onTestFinished(async () => {
    options.onFinish?.();
    await close();
  });
  return {
    stdout,
    stopped: stopped.promise,
    drainOutput: () => consumption.drain(),
    completeExit: () => exit.resolve({ code: 0, signal: null }),
    firstChunkConsumed: firstChunkConsumed.promise,
    frames,
    kill,
    completion,
    outcome,
    failWait: (error: Error) => {
      journal.resolve();
      exit.reject(error);
    },
    close,
    send: async (wire?: Buffer) => {
      journal.resolve();
      await journal.promise;
      if (wire) {
        stdout.write(wire);
      }
    },
  };
}

describe("node worker output framing", () => {
  it("requests stop after consumer failure and joins separately completed child output", async () => {
    const failure = new Error("synthetic stdout consumer failed");
    const harness = observationHarness({ consumeError: failure });
    const settled = vi.fn();
    void harness.outcome.then(settled, settled);
    await harness.send(encodeResult("first"));
    await harness.stopped;
    await expect(harness.drainOutput()).rejects.toBe(failure);
    // Rejection handlers must settle before checking that child exit still owns completion.
    await nextEventLoopTurn();
    expect(harness.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(settled).not.toHaveBeenCalled();
    harness.completeExit();
    expect(await harness.outcome).toEqual({ state: "failed", errorText: failure.message });
    expect(harness.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  });

  const retained = {
    ...resultFrame("first"),
    retainWorker: true,
    retention: "background",
  } satisfies WorkerProcessMessage;
  const idle = { type: "idle-ready", turnId: "first" } satisfies WorkerProcessMessage;
  const unicode = encodeResult("first", "hello 漢😀");
  const split = unicode.indexOf(Buffer.from("😀"));
  const largeLeaf = "x".repeat(
    NODE_WORKER_STDOUT_MAX_BYTES / 2 + 1 - encodeResult("first", "").length,
  );

  it.each<[string, Buffer[], WorkerProcessMessage[]]>([
    [
      "idle readiness after a retained result",
      [Buffer.from(`${JSON.stringify(retained)}\n${JSON.stringify(idle)}\n`)],
      [retained, idle],
    ],
    [
      "UTF-8 split across decoded chunks",
      [
        unicode.subarray(0, split + 1),
        unicode.subarray(split + 1, split + 3),
        unicode.subarray(split + 3),
      ],
      [resultFrame("first", "hello 漢😀")],
    ],
    [
      "bounded frames whose combined chunk exceeds the cap",
      [Buffer.concat([encodeResult("first", largeLeaf), encodeResult("second", largeLeaf)])],
      [resultFrame("first", largeLeaf), resultFrame("second", largeLeaf)],
    ],
  ])("delivers %s after journaling", async (_name, chunks, frames) => {
    const harness = observationHarness();
    await harness.send();
    for (const chunk of chunks.slice(0, -1)) {
      harness.stdout.write(chunk);
    }
    expect(harness.frames).toEqual([]);
    harness.stdout.write(chunks.at(-1)!);
    const lastResult = frames.findLast((frame) => frame.type === "result");
    expect(await harness.close()).toEqual(completed(lastResult!.result));
    expect(harness.frames).toEqual(frames);
    expect(harness.kill).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "fences late frames after wait failure (accepted write: %s)",
    async (acceptedWrite) => {
      const resultGate = createEnteredGate();
      const harness = observationHarness({
        onFinish: () => resultGate.release(),
        onResult: resultGate.wait,
      });
      const settled = vi.fn();
      void harness.outcome.then(settled);
      if (acceptedWrite) {
        await harness.send(Buffer.concat([encodeResult("first"), encodeResult("late")]));
        await resultGate.entered;
      }
      harness.failWait(new Error("worker wait failed"));
      if (acceptedWrite) {
        await Promise.resolve();
        expect(settled).not.toHaveBeenCalled();
        resultGate.release();
      }
      expect(await harness.outcome).toMatchObject({ state: "failed" });
      if (!acceptedWrite) {
        harness.stdout.write(encodeResult("late"));
      }
      await harness.firstChunkConsumed;
      expect(harness.frames).toEqual(acceptedWrite ? [resultFrame("first")] : []);
    },
  );

  it.each<[boolean, number]>([
    [true, 1],
    [false, 0],
    [false, 1],
  ])("bounds stdout (journal ready: %s, bytes over cap: %s)", async (journaled, delta) => {
    const harness = observationHarness();
    if (journaled) {
      await harness.send();
    }
    harness.stdout.write(
      Buffer.concat([
        journaled ? encodeResult("first") : sizedResult("first", NODE_WORKER_STDOUT_MAX_BYTES / 2),
        journaled
          ? Buffer.alloc(NODE_WORKER_STDOUT_MAX_BYTES + 1, 120)
          : sizedResult("second", NODE_WORKER_STDOUT_MAX_BYTES / 2 + delta),
      ]),
    );
    await harness.firstChunkConsumed;
    expect(harness.frames).toEqual(journaled ? [resultFrame("first")] : []);
    expect(harness.kill).toHaveBeenCalledTimes(delta);
    const outcome = await harness.close();
    expect(outcome).toMatchObject(delta > 0 ? overflow : { state: "completed" });
    if (delta) {
      expect(harness.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    }
    expect(harness.frames.map((frame) => ("turnId" in frame ? frame.turnId : undefined))).toEqual(
      journaled ? ["first"] : delta > 0 ? [] : ["first", "second"],
    );
  });

  it.each<[string, Buffer, number]>([
    ["empty output", Buffer.alloc(0), 0],
    ["an unterminated result", encodeResult("first").subarray(0, -1), 0],
    [
      "a complete result followed by incomplete UTF-8",
      Buffer.concat([encodeResult("first"), Buffer.from([0xf0, 0x9f])]),
      1,
    ],
  ])("rejects EOF with %s", async (_name, wire, frames) => {
    const harness = observationHarness();
    await harness.send(wire);

    expect(await harness.close()).toMatchObject({
      state: "failed",
      errorText: "worker exited without a complete turn result",
    });
    expect(harness.frames).toHaveLength(frames);
  });
});

describe("node worker cleanup observation", () => {
  const uncertainExtinction = {
    status: "uncertain",
    reason: "job-observation-failed",
    cause: new Error("cleanup failed with framing-fixture-token"),
  } satisfies ProcessExtinctionResult;

  it("reports and redacts uncertain native completion", async () => {
    const harness = observationHarness({
      waitForExtinction: async () => uncertainExtinction,
      expectedKind: "deferred",
    });
    await harness.send(encodeResult("first"));
    const outcome = await harness.close();

    expect(outcome).toEqual({ state: "failed", errorText: expect.stringContaining("cleanup") });
    expect(outcome.errorText ?? "").not.toContain("framing-fixture-token");
    expect(harness.frames).toEqual([resultFrame("first")]);
  });

  it.each([true, false])(
    "joins authoritative container cleanup after uncertain attach completion (removed=%s)",
    async (removed) => {
      const removal = createDeferred();
      const cleanupContainer = vi.fn(() => removal.promise);
      const harness = observationHarness({
        waitForExtinction: async () => uncertainExtinction,
        cleanupContainer,
        expectedKind: removed ? "confirmed" : "deferred",
        onFinish: () => removal.resolve(),
      });
      const settled = vi.fn();
      await harness.send(encodeResult("first"));
      const closing = harness.close();
      void closing.then(settled, settled);
      await vi.waitFor(() => expect(cleanupContainer).toHaveBeenCalledOnce());
      expect(settled).not.toHaveBeenCalled();

      if (removed) {
        removal.resolve();
      } else {
        removal.reject(new Error("container removal failed"));
      }
      await closing;

      expect(await harness.completion).toEqual({
        kind: removed ? "confirmed" : "deferred",
        outcome: completed(),
      });
      expect(cleanupContainer).toHaveBeenCalledOnce();
    },
  );
});
