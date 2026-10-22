/// <reference lib="es2024.sharedmemory" />

import assert from "node:assert/strict";
import { once } from "node:events";
import { mock } from "node:test";
import { setImmediate } from "node:timers/promises";
import { isMainThread, threadId, Worker } from "node:worker_threads";
import {
  cancelWorkerNativeSections,
  createWorkerNativeSectionState,
} from "@openclaw/worker-runtime/worker";
import { createDeferredCore } from "../shared/deferred.js";
import { WorkerTaskPool } from "./worker-task-pool.js";
import { serveWorkerTasks } from "./worker-task-server.js";

type Input =
  | {
      kind: "native-exchange";
      gate: SharedArrayBuffer;
      beforeRequest?: boolean;
      blockResponse?: boolean;
    }
  | { kind: "echo"; value: number };
type Result = { threadId: number; value?: number };
export type NativeExchangeScenario = "close" | "before-request" | "reply-race" | "stale-reply";

async function waitFor(gate: Int32Array<SharedArrayBuffer>, index: number): Promise<void> {
  await Atomics.waitAsync(gate, index, 0, 10_000).value;
  assert.equal(Atomics.load(gate, index), 1);
}

function release(gate: Int32Array<SharedArrayBuffer>, index: number): void {
  Atomics.store(gate, index, 1);
  Atomics.notify(gate, index);
}

if (!isMainThread) {
  serveWorkerTasks<Result, Input>(async (input, channel, control) => {
    if (input.kind === "echo") {
      return { threadId, value: input.value };
    }
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
    scenario && ["close", "before-request", "reply-race", "stale-reply"].includes(scenario),
  );
  if (scenario === "close" || scenario === "before-request") {
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
          assert.ok(oldWorker instanceof Worker && oldWorker.threadId === -1);
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
      assert.deepEqual([inputReleased, nativeSettled], [false, false]);
      assert.equal(completed, false);
      assert.equal(successorStarted, false);
      hostReply.resolve();
      await setImmediate();
      assert.equal(replyReleased, false, "late host reply retains custody until worker exit");
      release(gate, 3);
      const result = await outcome;
      assert.ok(result?.status === "rejected");
      assert.equal(result.reason, reason);
      const oldWorker = terminate.mock.calls[0]?.this;
      assert.ok(oldWorker instanceof Worker && oldWorker.threadId === -1);
      assert.equal(Atomics.load(gate, 4), 1);
      assert.deepEqual([inputReleased, nativeSettled], [true, true]);
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
    const sendTask = (taskId: number, input: Input, nativeSections = native.buffer) =>
      worker.postMessage(
        {
          taskId,
          input,
          interactive: input.kind === "native-exchange",
          nativeSections,
          taskContext: { deletedAgentDatabaseFences: [] },
        },
        [],
      );
    const reply = (responseId: number, input: string) =>
      worker.postMessage({ taskId: 1, responseId, input }, []);
    try {
      release(gate, 3);
      const requested = once(worker, "message");
      sendTask(1, {
        kind: "native-exchange",
        gate: gate.buffer,
        blockResponse: scenario === "reply-race",
      });
      const [request] = await requested;
      assert.equal(request.status, "request");
      const failed = once(worker, "message");
      if (scenario === "reply-race") {
        await waitFor(gate, 5);
        reply(request.id, "already queued reply");
      }
      cancelWorkerNativeSections(native);
      release(gate, 6);
      assert.equal((await failed)[0].status, "failed");
      assert.equal(Atomics.load(gate, 4), 1);
      assert.equal(Atomics.load(gate, 7), 0, "cancellation must not deliver host data");
      assert.equal(Atomics.notify(native, 0), 0);
      if (scenario === "reply-race") {
        const next = once(worker, "message");
        reply(request.id, "discarded late reply");
        sendTask(2, { kind: "echo", value: 42 }, createWorkerNativeSectionState().buffer);
        assert.equal((await next)[0].value.value, 42);
        console.log(JSON.stringify({ scenario, successorCompleted: true }));
      } else {
        const failure = once(worker, "error");
        const exit = new Promise<void>((resolve) => {
          worker.once("exit", () => resolve());
        });
        reply(request.id + 1, "unrelated stale reply");
        assert.match((await failure)[0].message, /stale worker task response/);
        await exit;
        console.log(JSON.stringify({ scenario, unrelatedStaleRejected: true }));
      }
    } finally {
      release(gate, 3);
      if (!exited) {
        await worker.terminate();
      }
    }
  }
}
