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
import { createOwnedWorkerTaskPool, WorkerTaskPool } from "./worker-task-pool.js";
import { serveWorkerTasks } from "./worker-task-server.js";

type Input =
  | {
      kind: "native-exchange";
      gate: SharedArrayBuffer;
      beforeRequest?: boolean;
      blockResponse?: boolean;
    }
  | { kind: "echo"; value: number }
  | { kind: "progress"; gate: SharedArrayBuffer; callbacks: boolean; fail: boolean };
type Result = { threadId: number; value?: number };
const scenarios = [
  "close",
  "before-request",
  "reply-race",
  "stale-reply",
  "progress-reply",
  "progress-callbacks",
  "progress-failure",
] as const;
export type NativeExchangeScenario = (typeof scenarios)[number];

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
    if (input.kind === "progress") {
      const gate = new Int32Array(input.gate);
      release(gate, 0);
      await waitFor(gate, 1);
      let value = 42;
      if (input.callbacks) {
        assert.ok(channel);
        channel.consumeInput();
        await waitFor(gate, 2);
        channel.notify("progress notification");
        await waitFor(gate, 3);
        const response = await channel.request("progress request");
        assert.ok(typeof response.input === "number");
        value = response.input;
        response.consumed();
        await waitFor(gate, 4);
      }
      if (input.fail) {
        throw new Error("progress fixture failed");
      }
      return { threadId, value };
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
  assert.ok(scenario && scenarios.some((value) => value === scenario));
  if (scenario.startsWith("progress-")) {
    const gate = new Int32Array(new SharedArrayBuffer(20));
    const progress = new Int32Array(new SharedArrayBuffer(4));
    const events: string[] = [];
    const callbacks = scenario === "progress-callbacks";
    const fail = scenario === "progress-failure";
    const pool = createOwnedWorkerTaskPool<Input, Result>(
      { workerUrl: new URL(import.meta.url), maxWorkers: 1 },
      { retainedTransport: true },
    );
    const task = pool.startTask(
      { kind: "progress", gate: gate.buffer, callbacks, fail },
      {
        progressSignal: progress,
        ...(callbacks
          ? {
              onInputConsumed() {
                events.push("input");
                release(gate, 2);
              },
              onNotification(value: unknown) {
                assert.equal(value, "progress notification");
                events.push("notification");
                release(gate, 3);
              },
              onRequestSync(value: unknown) {
                assert.equal(value, "progress request");
                events.push("request");
                return {
                  input: 42,
                  timeoutMs: 10_000,
                  onConsumed() {
                    events.push("response");
                    release(gate, 4);
                  },
                };
              },
            }
          : {}),
      },
    );
    const settled = task.result.catch(() => {});
    try {
      await waitFor(gate, 0);
      let observed = Atomics.load(progress, 0);
      task.service();
      assert.equal(task.read().status, "pending");
      release(gate, 1);
      for (;;) {
        // A producer must publish its reply before waking this blocked host.
        assert.notEqual(Atomics.wait(progress, 0, observed, 10_000), "timed-out");
        observed = Atomics.load(progress, 0);
        task.service();
        const outcome = task.read();
        if (!callbacks) {
          assert.notEqual(outcome.status, "pending", "Wake preceded the posted reply");
        }
        if (outcome.status === "pending") {
          continue;
        }
        if (fail) {
          assert.ok(outcome.status === "rejected");
          assert.match(String(outcome.error), /progress fixture failed/);
        } else {
          assert.ok(outcome.status === "fulfilled");
          assert.equal(outcome.value.value, 42);
        }
        break;
      }
      assert.deepEqual(events, callbacks ? ["input", "notification", "request", "response"] : []);
      console.log(JSON.stringify({ scenario, wokeForPostedMessages: true }));
    } finally {
      for (let index = 1; index < gate.length; index++) {
        release(gate, index);
      }
      await settled;
      await task.release().result;
      await pool.close();
    }
  } else if (scenario === "close" || scenario === "before-request") {
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
      await worker.terminate();
    }
  }
}
