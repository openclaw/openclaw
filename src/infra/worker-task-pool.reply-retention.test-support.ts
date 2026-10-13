import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate } from "node:timers/promises";
import { resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { workerTaskPoolEntrypoints } from "./worker-task-pool-runtime.test-support.js";
import { createOwnedWorkerTaskPool, WorkerTaskPool } from "./worker-task-pool.js";
import type { PoolFixtureInput, PoolFixtureResult } from "./worker-task-pool.test-support.js";

const gc = globalThis.gc;
assert.ok(gc, "The retention child requires --expose-gc");
const callerContext = new AsyncLocalStorage<object>();
const pool = new WorkerTaskPool<PoolFixtureInput, PoolFixtureResult>({
  workerUrl: resolveRuntimeWorkerUrl(workerTaskPoolEntrypoints.worker),
  maxWorkers: 1,
});

async function receiveFirstReply() {
  const context = { history: ["synthetic completed caller"] };
  const contextReference = new WeakRef(context);
  const result = await callerContext.run(context, () =>
    pool.run({ label: "first reply", buffer: new ArrayBuffer(4) }, { timeoutMs: 10_000 }),
  );
  assert.equal(result.label, "first reply");
  assert.equal(result.buffer?.byteLength, 4);
  return { reference: new WeakRef(result), contextReference, threadId: result.threadId };
}

try {
  const { reference, contextReference, threadId } = await receiveFirstReply();
  const control = new WeakRef({ unowned: true });
  for (let pass = 0; pass < 8; pass += 1) {
    await setImmediate();
    gc();
  }
  assert.equal(control.deref(), undefined, "Unowned control must collect");
  assert.equal(reference.deref(), undefined, "Warm worker retained its first completed reply");
  assert.equal(
    contextReference.deref(),
    undefined,
    "Warm worker retained its completed caller context",
  );
  const next = await pool.run({ label: "warm worker" }, { timeoutMs: 10_000 });
  assert.equal(next.threadId, threadId, "The worker must remain reusable during collection");
  assert.equal(next.previousBufferBytes, 0, "The same worker must retain its transferred marker");
} finally {
  await pool.close();
}

const ownedPool = createOwnedWorkerTaskPool<PoolFixtureInput, PoolFixtureResult>({
  workerUrl: resolveRuntimeWorkerUrl(workerTaskPoolEntrypoints.worker),
  maxWorkers: 1,
});

function receiveOwnedReply() {
  const context = { history: ["synthetic retained caller"] };
  const contextReference = new WeakRef(context);
  const task = callerContext.run(context, () => ownedPool.runTask({ label: "owned reply" }, {}));
  return { task, contextReference };
}

try {
  const { task, contextReference } = receiveOwnedReply();
  assert.equal((await task.result).label, "owned reply");
  assert.notEqual(
    contextReference.deref(),
    undefined,
    "Admitted cleanup must retain caller context",
  );
  await task.close();
  const control = new WeakRef({ unowned: true });
  for (let pass = 0; pass < 8; pass += 1) {
    await setImmediate();
    gc();
  }
  assert.equal(control.deref(), undefined, "Unowned control must collect");
  assert.equal(contextReference.deref(), undefined, "Released task retained its caller context");
  assert.equal((await task.result).label, "owned reply", "The task handle must remain usable");
  await task.close();
} finally {
  await ownedPool.close();
}
