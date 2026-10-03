import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { collectForRetentionCheck } from "../test-utils/retention.js";

const [root, mode] = process.argv.slice(2);
assert.ok(root && mode, "Lifecycle retention requires its temporary directory and resource");

class LifecycleTailCaller {
  readonly prompt = Buffer.alloc(1024 * 1024, 39);
  constructor(readonly label: string) {}
}
const callers = new AsyncLocalStorage<LifecycleTailCaller>();
const references: Array<{ label: string; reference: WeakRef<object> }> = [];

async function withCaller(label: string, run: () => unknown | Promise<unknown>) {
  const caller = new LifecycleTailCaller(label);
  references.push(
    { label: `${label} context`, reference: new WeakRef(caller) },
    { label: `${label} prompt`, reference: new WeakRef(caller.prompt) },
  );
  await callers.run(caller, async () => {
    await run();
    assert.equal(callers.getStore(), caller, "An operation must retain its own caller context");
  });
}

async function assertCollected() {
  await collectForRetentionCheck(mode!);
  assert.deepEqual(
    references.filter(({ reference }) => reference.deref()).map(({ label }) => label),
    [],
    `The live ${mode} resource retained completed caller state`,
  );
}

if (mode === "native-source") {
  const { captureRetainedNativeWorkerSource } = await import("./worker-native-lifecycle.js");
  const { drainGlobalSingletonLifecycleState } = await import("../shared/global-singleton.js");
  let source: ReturnType<typeof captureRetainedNativeWorkerSource> | undefined;
  try {
    await withCaller("native source creation", () => {
      source = captureRetainedNativeWorkerSource({ runtimeGeneration: undefined });
    });
    assert.ok(source);
    source.retain({}, async () => {});
    await assertCollected();
    assert.equal(captureRetainedNativeWorkerSource({ runtimeGeneration: undefined }), source);
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
    await withCaller("question resolver", () =>
      owner.handleResolved({ id: record.id, status: "cancelled" }),
    );
    await assertCollected();
    let finalized = false;
    owner.registerDelivery({
      questionId: record.id,
      deliveryId: "late-delivery",
      finalize: (line) => {
        assert.equal(line, "Cancelled");
        finalized = true;
      },
    });
    assert.equal(finalized, true, "Cleanup scheduling must preserve late-delivery finalization");
  } finally {
    await owner.clear();
    await scheduler.stop();
  }
} else {
  throw new Error(`Unknown lifecycle retention resource: ${mode}`);
}
process.stdout.write(
  JSON.stringify({ resource: mode, collected: references.length, reused: true }),
);
