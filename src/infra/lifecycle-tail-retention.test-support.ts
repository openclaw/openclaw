import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { collectForRetentionCheck } from "../test-utils/retention.js";

const [root, mode] = process.argv.slice(2);
assert.ok(root && mode, "Lifecycle retention requires its temporary directory and resource");

const callers = new AsyncLocalStorage<object>();
const references: WeakRef<object>[] = [];
function createCaller() {
  const caller = { prompt: Buffer.alloc(1024 * 1024, 39) };
  references.push(new WeakRef(caller), new WeakRef(caller.prompt));
  return caller;
}

async function withCaller<T>(run: () => T | Promise<T>) {
  const caller = createCaller();
  return callers.run(caller, async () => {
    const result = await run();
    assert.equal(callers.getStore(), caller, "An operation must retain its own caller context");
    return result;
  });
}

async function assertCollected() {
  await collectForRetentionCheck(mode!);
  assert.deepEqual(
    references.filter((reference) => reference.deref()),
    [],
  );
}

if (mode === "native-source") {
  const { captureRetainedNativeWorkerSource } = await import("./worker-native-lifecycle.js");
  const { drainGlobalSingletonLifecycleState } = await import("../shared/global-singleton.js");
  const captureSource = () => captureRetainedNativeWorkerSource({ runtimeGeneration: undefined });
  try {
    const source = await withCaller(captureSource);
    source.retain({}, async () => {});
    await assertCollected();
    assert.equal(captureSource(), source);
    assert.equal(await source.retireIdleBroker(), true);
  } finally {
    await drainGlobalSingletonLifecycleState();
  }
} else if (mode === "question-cleanup") {
  const { createQuestionChannelRuntime } = await import("./question-channel-runtime-internal.js");
  const { GatewayScheduler } = await import("./gateway-scheduler.js");
  const scheduler = new GatewayScheduler();
  const owner = createQuestionChannelRuntime();
  const record = {
    id: "ask_0123456789abcdef0123456789abcdef",
    status: "pending" as const,
    questions: [],
    createdAtMs: 1,
    expiresAtMs: 2,
  };
  owner.handleRequested(record, scheduler);
  try {
    await withCaller(() => owner.handleResolved({ id: record.id, status: "cancelled" }));
    await assertCollected();
    const finalized: string[] = [];
    owner.registerDelivery({
      questionId: record.id,
      deliveryId: "late-delivery",
      finalize: (line) => {
        finalized.push(line);
      },
    });
    assert.deepEqual(finalized, ["Cancelled"], "Cleanup must preserve late-delivery finalization");
  } finally {
    await owner.clear();
    await scheduler.stop();
  }
} else if (mode === "worker-pool") {
  const { WorkerTaskPool } = await import("./worker-task-pool.js");
  function abandonPool() {
    const caller = createCaller();
    const pool = new WorkerTaskPool<never, void>({
      workerUrl: new URL("file:///unused-worker.js"),
      maxWorkers: 1,
      validateResult() {
        assert.equal(caller.prompt.byteLength, 1024 * 1024);
      },
    });
    references.push(new WeakRef(pool));
  }
  // An unused pool has no worker resources and needs no explicit close to be collected.
  abandonPool();
  await assertCollected();
} else {
  throw new Error(`Unknown lifecycle retention resource: ${mode}`);
}
const detail =
  mode === "worker-pool" ? { runtime: process.versions.bun ? "bun" : "node" } : { reused: true };
process.stdout.write(JSON.stringify({ resource: mode, collected: references.length, ...detail }));
