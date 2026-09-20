/// <reference lib="es2024.sharedmemory" />

import assert from "node:assert/strict";
import { once } from "node:events";
import { mock } from "node:test";
import { setImmediate } from "node:timers/promises";
import { isMainThread, threadId, Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createDeferredCore } from "../shared/deferred.js";
import {
  cancelWorkerNativeSections,
  createWorkerNativeSectionState,
} from "./worker-task-native-sections.js";
import { serveWorkerTasks, WorkerTaskPool } from "./worker-task-pool.js";

type Input =
  | {
      kind: "native-exchange";
      gate: SharedArrayBuffer;
      beforeRequest?: boolean;
      blockResponse?: boolean;
    }
  | { kind: "echo"; value: number };
type Result = { threadId: number; value?: number };
export type NativeExchangeScenario =
  | "abort"
  | "close"
  | "before-request"
  | "late-reply"
  | "reply-race"
  | "stale-reply"
  | "reuse";

async function waitFor(gate: Int32Array<SharedArrayBuffer>, index: number): Promise<void> {
  await Atomics.waitAsync(gate, index, 0, 10_000).value;
  assert.equal(Atomics.load(gate, index), 1);
}

function release(gate: Int32Array<SharedArrayBuffer>, index: number): void {
  Atomics.store(gate, index, 1);
  Atomics.notify(gate, index);
}

if (!isMainThread) {
  serveWorkerTasks<Result>(async (input, channel, control) => {
    assert.ok(isRecord(input));
    if (input.kind === "echo") {
      assert.ok(typeof input.value === "number");
      if (channel) {
        const reply = await channel.request(input.value);
        assert.equal(reply.input, input.value);
        reply.consumed();
      }
      return { threadId, value: input.value };
    }
    assert.equal(input.kind, "native-exchange");
    assert.ok(input.gate instanceof SharedArrayBuffer);
    assert.ok(channel);
    const gate = new Int32Array(input.gate);
    await control.runNativeSection(async () => {
      release(gate, 0);
      try {
        if (input.beforeRequest) {
          await waitFor(gate, 1);
        }
        const response = channel.request("held host operation");
        if (input.blockResponse) {
          release(gate, 5);
          assert.notEqual(Atomics.wait(gate, 6, 0, 10_000), "timed-out");
        }
        await response;
        release(gate, 7);
        assert.fail("Canceled exchange must not resume with host data");
      } finally {
        release(gate, 2);
        await waitFor(gate, 3);
        release(gate, 4);
      }
    });
    return assert.fail("Canceled native section must not return a result");
  });
} else {
  const scenario = process.argv[2];
  assert.ok(
    scenario &&
      [
        "abort",
        "close",
        "before-request",
        "late-reply",
        "reply-race",
        "stale-reply",
        "reuse",
      ].includes(scenario),
  );
  if (scenario === "abort" || scenario === "close" || scenario === "before-request") {
    const gate = new Int32Array(new SharedArrayBuffer(32));
    const hostEntered = createDeferredCore();
    const hostReply = createDeferredCore();
    const controller = new AbortController();
    const reason = new Error("cancel native host exchange");
    const pool = new WorkerTaskPool<Input, Result>({
      workerUrl: new URL(import.meta.url),
      maxWorkers: 1,
      maxPendingTasks: 2,
    });
    const terminate = mock.method(Worker.prototype, "terminate");
    let hostCalls = 0;
    let inputReleased = false;
    let replyReleased = false;
    let nativeSettled = false;
    let completed = false;
    const active = pool.run(
      { kind: "native-exchange", gate: gate.buffer, beforeRequest: scenario === "before-request" },
      {
        signal: controller.signal,
        onInputConsumed: () => {
          inputReleased = true;
        },
        onExecutionSettled: ({ retired }) => {
          nativeSettled = retired;
        },
        onRequest: async () => {
          hostCalls++;
          hostEntered.resolve();
          await hostReply.promise;
          return {
            input: "late host result",
            timeoutMs: 10_000,
            onConsumed: () => {
              replyReleased = true;
            },
          };
        },
      },
    );
    const outcome = Promise.allSettled([active]).then(([result]) => {
      completed = true;
      return result;
    });
    let close: Promise<void> | undefined;
    let successorStarted = false;
    let successor: Promise<PromiseSettledResult<Result>[]> | undefined;
    try {
      await waitFor(gate, 0);
      if (scenario !== "before-request") {
        await hostEntered.promise;
      }
      successor = Promise.allSettled([
        pool.run(() => {
          successorStarted = true;
          const oldWorker = terminate.mock.calls[0]?.this;
          assert.ok(oldWorker instanceof Worker);
          assert.equal(oldWorker.threadId, -1);
          return { kind: "echo", value: 42 };
        }, {}),
      ]);
      if (scenario === "close") {
        close = pool.close(reason);
      } else {
        controller.abort(reason);
      }
      release(gate, 1);
      await waitFor(gate, 2);
      assert.equal(hostCalls, scenario === "before-request" ? 0 : 1);
      assert.equal(terminate.mock.callCount(), 0, "cleanup still owns its native section");
      assert.equal(inputReleased, false);
      assert.equal(nativeSettled, false);
      assert.equal(completed, false);
      assert.equal(successorStarted, false);
      hostReply.resolve();
      await setImmediate();
      assert.equal(replyReleased, false, "late host reply retains custody until worker exit");
      release(gate, 3);
      const result = await outcome;
      assert.equal(result?.status, "rejected");
      if (result?.status === "rejected") {
        assert.equal(result.reason, reason);
      }
      const oldWorker = terminate.mock.calls[0]?.this;
      assert.ok(oldWorker instanceof Worker);
      assert.equal(oldWorker.threadId, -1);
      assert.equal(Atomics.load(gate, 4), 1);
      assert.equal(inputReleased, true);
      assert.equal(nativeSettled, true);
      assert.equal(replyReleased, scenario !== "before-request");
      const [next] = await successor;
      assert.equal(next?.status, scenario === "close" ? "rejected" : "fulfilled");
      await close;
      console.log(JSON.stringify({ scenario, cleanupJoined: true, successorStarted }));
    } finally {
      release(gate, 1);
      release(gate, 3);
      hostReply.resolve();
      await pool.close();
      await outcome;
      await successor;
      terminate.mock.restore();
    }
  } else {
    const worker = new Worker(new URL(import.meta.url));
    const native = createWorkerNativeSectionState();
    const gate = new Int32Array(new SharedArrayBuffer(32));
    let exited = false;
    worker.once("exit", () => {
      exited = true;
    });
    try {
      if (scenario === "reuse") {
        for (let taskId = 1; taskId <= 16; taskId++) {
          const requested = once(worker, "message");
          worker.postMessage(
            {
              taskId,
              input: { kind: "echo", value: taskId },
              interactive: true,
              nativeSections: native.buffer,
            },
            [],
          );
          const [request] = await requested;
          assert.equal(request.status, "request");
          assert.equal(request.taskId, taskId);
          const consumed = once(worker, "message");
          const done = new Promise<void>((resolve) => {
            const receive = (message: { status: string; taskId: number }) => {
              if (message.status === "ok") {
                assert.equal(message.taskId, taskId);
                worker.off("message", receive);
                resolve();
              }
            };
            worker.on("message", receive);
          });
          worker.postMessage({ taskId, responseId: request.id, input: taskId }, []);
          assert.equal((await consumed)[0].status, "consumed");
          await done;
          assert.equal(Atomics.notify(native, 0), 0, "completed task left a cancellation waiter");
        }
        console.log(JSON.stringify({ scenario, waiterFreeTasks: 16 }));
      } else {
        release(gate, 3);
        const requested = once(worker, "message");
        worker.postMessage(
          {
            taskId: 1,
            input: {
              kind: "native-exchange",
              gate: gate.buffer,
              blockResponse: scenario === "reply-race",
            },
            interactive: true,
            nativeSections: native.buffer,
          },
          [],
        );
        const [request] = await requested;
        assert.equal(request.status, "request");
        const failed = once(worker, "message");
        if (scenario === "reply-race") {
          await waitFor(gate, 5);
          worker.postMessage(
            { taskId: 1, responseId: request.id, input: "already queued reply" },
            [],
          );
        }
        cancelWorkerNativeSections(native);
        release(gate, 6);
        assert.equal((await failed)[0].status, "failed");
        assert.equal(Atomics.load(gate, 4), 1);
        assert.equal(Atomics.load(gate, 7), 0, "cancellation must not deliver host data");
        assert.equal(Atomics.notify(native, 0), 0);
        if (scenario === "late-reply" || scenario === "reply-race") {
          const next = once(worker, "message");
          worker.postMessage(
            { taskId: 1, responseId: request.id, input: "discarded late reply" },
            [],
          );
          worker.postMessage(
            {
              taskId: 2,
              input: { kind: "echo", value: 42 },
              nativeSections: createWorkerNativeSectionState().buffer,
            },
            [],
          );
          assert.equal((await next)[0].value.value, 42);
          console.log(JSON.stringify({ scenario, successorCompleted: true }));
        } else {
          const failure = once(worker, "error");
          const exit = new Promise<void>((resolve) => {
            worker.once("exit", () => resolve());
          });
          worker.postMessage(
            {
              taskId: 1,
              responseId: request.id + 1,
              input: "unrelated stale reply",
            },
            [],
          );
          assert.match((await failure)[0].message, /stale worker task response/);
          await exit;
          console.log(JSON.stringify({ scenario, unrelatedStaleRejected: true }));
        }
      }
    } finally {
      release(gate, 3);
      if (!exited) {
        await worker.terminate();
      }
    }
  }
}
