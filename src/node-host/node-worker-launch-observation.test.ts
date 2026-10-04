import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
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

function observationHarness(
  options: {
    waitForExtinction?: NodeWorkerChildAdapter["waitForExtinction"];
    cleanupContainer?: () => Promise<void>;
    expectedKind?: "confirmed" | "deferred";
    onResult?: (frame: WorkerProcessMessage) => Promise<void>;
  } = {},
) {
  const stdout = new PassThrough();
  const consumption = createAwaitedDecodedOutput(stdout, () => kill("SIGKILL"));
  const stderr = new PassThrough();
  const journal = createDeferred();
  const exit = createDeferred<{ code: number | null; signal: NodeJS.Signals | null }>();
  const firstChunkConsumed = createDeferred();
  const unsubscribe: Array<() => void> = [];
  const kill = vi.fn((_signal?: NodeJS.Signals) => {});
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
      try {
        return await outcome;
      } finally {
        dispose();
      }
    })());
  return {
    stdout,
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
    releaseJournal: async () => {
      journal.resolve();
      await journal.promise;
    },
  };
}

describe("node worker output framing", () => {
  const retained = { ...resultFrame("first"), retainWorker: true, retention: "background" };
  const idle = { type: "idle-ready", turnId: "first" };
  const unicode = encodeResult("first", "hello 漢😀");
  const split = unicode.indexOf(Buffer.from("😀"));
  const largeLeaf = "x".repeat(
    NODE_WORKER_STDOUT_MAX_BYTES / 2 + 1 - encodeResult("first", "").length,
  );

  it.each([
    {
      name: "idle readiness after a retained result",
      chunks: [Buffer.from(`${JSON.stringify(retained)}\n${JSON.stringify(idle)}\n`)],
      frames: [retained, idle],
      result: retained.result,
    },
    {
      name: "UTF-8 split across decoded chunks",
      chunks: [
        unicode.subarray(0, split + 1),
        unicode.subarray(split + 1, split + 3),
        unicode.subarray(split + 3),
      ],
      frames: [resultFrame("first", "hello 漢😀")],
      result: resultFrame("first", "hello 漢😀").result,
    },
    {
      name: "bounded frames whose combined chunk exceeds the cap",
      chunks: [
        Buffer.concat([encodeResult("first", largeLeaf), encodeResult("second", largeLeaf)]),
      ],
      frames: [resultFrame("first", largeLeaf), resultFrame("second", largeLeaf)],
      result: resultFrame("second", largeLeaf).result,
    },
  ])("delivers $name after journaling", async ({ chunks, frames, result }) => {
    const harness = observationHarness();
    try {
      await harness.releaseJournal();
      for (const chunk of chunks.slice(0, -1)) {
        harness.stdout.write(chunk);
      }
      expect(harness.frames).toEqual([]);
      harness.stdout.write(chunks.at(-1)!);
      expect(await harness.close()).toEqual({
        state: "completed",
        resultJson: JSON.stringify(result),
      });
      expect(harness.frames).toEqual(frames);
      expect(harness.kill).not.toHaveBeenCalled();
    } finally {
      await harness.close();
    }
  });

  it.each([false, true])(
    "fences late frames after wait failure (accepted write: %s)",
    async (acceptedWrite) => {
      const resultStarted = createDeferred();
      const resultFinished = createDeferred();
      const harness = observationHarness({
        onResult: async () => {
          resultStarted.resolve();
          await resultFinished.promise;
        },
      });
      const settled = vi.fn();
      void harness.outcome.then(settled);
      try {
        if (acceptedWrite) {
          await harness.releaseJournal();
          harness.stdout.write(Buffer.concat([encodeResult("first"), encodeResult("late")]));
          await resultStarted.promise;
        }
        harness.failWait(new Error("worker wait failed"));
        if (acceptedWrite) {
          await Promise.resolve();
          expect(settled).not.toHaveBeenCalled();
          resultFinished.resolve();
        }
        expect(await harness.outcome).toMatchObject({ state: "failed" });
        if (!acceptedWrite) {
          harness.stdout.write(encodeResult("late"));
        }
        await harness.firstChunkConsumed;
        expect(harness.frames).toEqual(acceptedWrite ? [resultFrame("first")] : []);
      } finally {
        resultFinished.resolve();
        await harness.close();
      }
    },
  );

  it("delivers an earlier frame before rejecting a later oversized frame in the same chunk", async () => {
    const harness = observationHarness();
    try {
      await harness.releaseJournal();
      harness.stdout.write(
        Buffer.concat([encodeResult("first"), Buffer.alloc(NODE_WORKER_STDOUT_MAX_BYTES + 1, 120)]),
      );
      await harness.firstChunkConsumed;

      expect(harness.frames).toEqual([resultFrame("first")]);
      expect(await harness.close()).toMatchObject({
        state: "failed",
        errorText: `worker stdout exceeded ${NODE_WORKER_STDOUT_MAX_BYTES} bytes`,
      });
      expect(harness.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    } finally {
      await harness.close();
    }
  });

  it.each([0, 1])(
    "bounds aggregate output including delimiters at cap + %i before journal readiness",
    async (delta) => {
      const harness = observationHarness();
      try {
        harness.stdout.write(
          Buffer.concat([
            sizedResult("first", NODE_WORKER_STDOUT_MAX_BYTES / 2),
            sizedResult("second", NODE_WORKER_STDOUT_MAX_BYTES / 2 + delta),
          ]),
        );
        await harness.firstChunkConsumed;

        expect(harness.frames).toEqual([]);
        expect(harness.kill).toHaveBeenCalledTimes(delta > 0 ? 1 : 0);
        const outcome = await harness.close();
        if (delta > 0) {
          expect(outcome).toMatchObject({
            state: "failed",
            errorText: `worker stdout exceeded ${NODE_WORKER_STDOUT_MAX_BYTES} bytes`,
          });
          expect(harness.frames).toEqual([]);
        } else {
          expect(outcome).toMatchObject({ state: "completed" });
          expect(
            harness.frames.map((frame) => ("turnId" in frame ? frame.turnId : undefined)),
          ).toEqual(["first", "second"]);
        }
      } finally {
        await harness.close();
      }
    },
  );

  it.each([
    { name: "empty output", wire: Buffer.alloc(0), frames: 0 },
    { name: "an unterminated result", wire: encodeResult("first").subarray(0, -1), frames: 0 },
    {
      name: "a complete result followed by incomplete UTF-8",
      wire: Buffer.concat([encodeResult("first"), Buffer.from([0xf0, 0x9f])]),
      frames: 1,
    },
  ])("rejects EOF with $name", async ({ wire, frames }) => {
    const harness = observationHarness();
    try {
      await harness.releaseJournal();
      harness.stdout.write(wire);

      expect(await harness.close()).toMatchObject({
        state: "failed",
        errorText: "worker exited without a complete turn result",
      });
      expect(harness.frames).toHaveLength(frames);
    } finally {
      await harness.close();
    }
  });
});

describe("node worker cleanup observation", () => {
  const uncertainExtinction = {
    status: "uncertain",
    reason: "job-observation-failed",
    cause: new Error("cleanup failed with framing-fixture-token"),
  } satisfies ProcessExtinctionResult;

  it.each([
    { name: "confirmed", extinction: { status: "confirmed" }, kind: "confirmed" },
    { name: "uncertain", extinction: uncertainExtinction, kind: "deferred" },
  ] as const)("observes $name native completion", async ({ extinction, kind }) => {
    const harness = observationHarness({
      waitForExtinction: async () => extinction,
      expectedKind: kind,
    });
    try {
      await harness.releaseJournal();
      harness.stdout.write(encodeResult("first"));
      const outcome = await harness.close();

      if (kind === "deferred") {
        expect(outcome).toMatchObject({
          state: "failed",
          errorText: expect.stringContaining("cleanup"),
        });
        expect(outcome.errorText).not.toContain("framing-fixture-token");
        expect(outcome.resultJson).toBeUndefined();
      } else {
        expect(outcome).toEqual({
          state: "completed",
          resultJson: JSON.stringify(resultFrame("first").result),
        });
      }
      expect(harness.frames).toEqual([resultFrame("first")]);
    } finally {
      await harness.close();
    }
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
      });
      const settled = vi.fn();
      try {
        await harness.releaseJournal();
        harness.stdout.write(encodeResult("first"));
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
          outcome: {
            state: "completed",
            resultJson: JSON.stringify(resultFrame("first").result),
          },
        });
        expect(cleanupContainer).toHaveBeenCalledOnce();
      } finally {
        removal.resolve();
        await harness.close();
      }
    },
  );
});
