/// <reference lib="es2024.sharedmemory" />

import assert from "node:assert/strict";
import { mock } from "node:test";
import { setImmediate } from "node:timers/promises";
import { isMainThread, threadId, Worker, workerData } from "node:worker_threads";
import { deflateSync } from "node:zlib";
import { serveWorkerTasks, WorkerTaskPool } from "./worker-task-pool.js";

export type NativeCancellation = "abort" | "timeout" | "close";

type NativeControl = {
  runNativeSection: <T>(operation: () => T | Promise<T>) => Promise<T>;
  throwIfCancelled: () => void;
};

if (!isMainThread) {
  serveWorkerTasks<number>(async (input, _channel, control?: NativeControl) => {
    if (input === "successor") {
      return threadId;
    }
    if (input === "exit-native") {
      assert.ok(control);
      return control.runNativeSection(() => process.exit(1));
    }
    assert.ok(input instanceof SharedArrayBuffer);
    const gate = new Int32Array(input);
    if (workerData.outsideNative) {
      Atomics.store(gate, 0, 1);
      Atomics.notify(gate, 0);
      Atomics.wait(gate, 1, 0, 10_000);
      return threadId;
    }
    const compress = () => {
      deflateSync(Buffer.from("a synthetic PDF page"), {
        get rejectGarbageAfterEnd() {
          // Node reads this option after allocating the zlib handle, before init().
          if (Atomics.compareExchange(gate, 0, 0, 1) === 0) {
            Atomics.notify(gate, 0);
            assert.notEqual(Atomics.wait(gate, 1, 0, 10_000), "timed-out");
          }
          return false;
        },
      });
      Atomics.store(gate, 2, 1);
    };
    // The same fixture runs against the former two-argument owner for crash proof.
    if (control) {
      await control.runNativeSection(compress);
      control.throwIfCancelled();
    } else {
      compress();
    }
    Atomics.store(gate, 3, 1);
    return threadId;
  });
} else {
  const ending = process.argv[2];
  assert.ok(ending === "abort" || ending === "timeout" || ending === "close" || ending === "exit");
  const outsideNative = process.argv[3] === "outside-native";
  const gate = new Int32Array(new SharedArrayBuffer(16));
  const pool = new WorkerTaskPool<SharedArrayBuffer | string, number>({
    workerUrl: new URL(import.meta.url),
    workerOptions: { workerData: { outsideNative } },
    maxWorkers: 1,
    maxPendingTasks: 2,
  });
  const terminate = mock.method(Worker.prototype, "terminate");
  const firstTerminatedWorker = () => {
    const worker = terminate.mock.calls[0]?.this;
    assert.ok(worker instanceof Worker);
    return worker;
  };
  if (ending === "timeout") {
    mock.timers.enable({ apis: ["setTimeout"] });
  }
  const controller = new AbortController();
  const reason = new Error(`cancel native section by ${ending}`);
  let activeSettled = false;
  const active = pool.run(ending === "exit" ? "exit-native" : gate.buffer, {
    signal: controller.signal,
    timeoutMs: 10_000,
  });
  const outcome = Promise.allSettled([active]).then(([result]) => {
    activeSettled = true;
    return result;
  });
  try {
    if (ending === "exit") {
      const result = await outcome;
      assert.equal(result?.status, "rejected");
      if (result?.status === "rejected") {
        assert.equal(result.reason.code, "unavailable");
      }
      assert.equal(firstTerminatedWorker().threadId, -1);
      await pool.run("successor", {});
      console.log(JSON.stringify({ ending, exitJoined: true }));
    } else {
      await Atomics.waitAsync(gate, 0, 0, 10_000).value;
      assert.equal(Atomics.load(gate, 0), 1, "native allocation must precede cancellation");
      let successorStarted = false;
      const successor = pool.run(() => {
        successorStarted = true;
        assert.equal(
          firstTerminatedWorker().threadId,
          -1,
          "replacement must follow native worker exit",
        );
        return "successor";
      }, {});
      const successorOutcome = Promise.allSettled([successor]);
      const cancelledAt = performance.now();
      let closed: Promise<void> | undefined;
      let closeSettled = false;
      if (ending === "abort") {
        controller.abort(reason);
      } else if (ending === "timeout") {
        mock.timers.tick(10_000);
      } else {
        closed = pool.close(reason).then(() => {
          closeSettled = true;
        });
      }
      if (!outsideNative) {
        await setImmediate();
        // Against the old owner, keep the gate closed through the native destructor.
        await terminate.mock.calls[0]?.result;
        assert.equal(activeSettled, false, "cancellation must retain native custody");
        assert.equal(closeSettled, false, "pool close must retain native custody");
        assert.equal(
          terminate.mock.callCount(),
          0,
          "native initialization must not be interrupted",
        );
        assert.equal(successorStarted, false, "the active section must retain its worker slot");
        assert.equal(pool.getSnapshot().pendingTasks, ending === "close" ? 1 : 2);
      }

      const releasedAt = performance.now();
      if (!outsideNative) {
        Atomics.store(gate, 1, 1);
        Atomics.notify(gate, 1);
      }
      const result = await outcome;
      const settledAt = performance.now();
      assert.equal(result?.status, "rejected");
      if (result?.status === "rejected") {
        if (ending === "timeout") {
          assert.equal(result.reason.code, "timeout");
        } else {
          assert.equal(result.reason, reason);
        }
      }
      assert.equal(firstTerminatedWorker().threadId, -1, "cancellation must join native exit");
      assert.equal(Atomics.load(gate, 2), outsideNative ? 0 : 1, "native call completion");
      assert.equal(Atomics.load(gate, 3), 0, "cancellation must stop the next page");
      const [next] = await successorOutcome;
      assert.equal(next?.status, ending === "close" ? "rejected" : "fulfilled");
      assert.equal(successorStarted, ending !== "close");
      await closed;
      console.log(
        JSON.stringify({
          ending,
          outsideNative,
          cancelled: true,
          cancelToSettlementMs: settledAt - cancelledAt,
          ...(outsideNative ? {} : { nativeReleaseToSettlementMs: settledAt - releasedAt }),
        }),
      );
    }
  } finally {
    Atomics.store(gate, 1, 1);
    Atomics.notify(gate, 1);
    mock.timers.reset();
    await pool.close();
    await outcome;
    terminate.mock.restore();
  }
}
