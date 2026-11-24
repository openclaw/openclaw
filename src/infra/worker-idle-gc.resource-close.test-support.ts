import assert from "node:assert/strict";
import { MessagePort, parentPort } from "node:worker_threads";
import { serveOwnedWorkerTasks } from "@openclaw/worker-runtime/worker";
import { collectForRetentionCheck } from "../test-utils/retention.js";
import { cancelWorkerIdleGc, scheduleWorkerIdleGc } from "./worker-idle-gc.js";

const held = Buffer.alloc(64 * 1024 * 1024, 73);
const heldRef = new WeakRef(held);
const owner: { payload?: Buffer } = { payload: Buffer.alloc(64 * 1024 * 1024, 37) };
const released = new WeakRef(owner.payload!);
// Publish the live allocation in Bun's counters before exercising the real idle owner.
await collectForRetentionCheck("queued-resource-payload", 1);

let collectIdle: (() => void) | undefined;
globalThis.setTimeout = new Proxy(setTimeout, {
  apply(target, receiver, args: Parameters<typeof setTimeout>) {
    const timer: NodeJS.Timeout = Reflect.apply(target, receiver, args);
    clearTimeout(timer);
    const [callback, delay, ...params] = args;
    assert.equal(delay, 1_000);
    collectIdle = () => callback(...params);
    return timer;
  },
});

const firstRelease = Promise.withResolvers<void>();
const idle = Promise.withResolvers<void>();
let closed = 0;
let idleCount = 0;
let admitted = 0;
serveOwnedWorkerTasks(
  () => assert.fail("This fixture only closes resources"),
  {
    closeResource: async (key) => {
      if (key === "first") {
        await firstRelease.promise;
      } else {
        assert.equal(key, "second");
        assert.equal(idleCount, 0, "Pending resource cleanup must not publish idle");
        assert.equal(collectIdle, undefined, "Pending resource cleanup must not schedule GC");
        owner.payload = undefined;
      }
      closed++;
    },
  },
  {
    selectStartupPort: (message) => (message instanceof MessagePort ? message : undefined),
    initialize: () => {},
    onMessage: () => {
      cancelWorkerIdleGc();
      if (++admitted === 2) {
        parentPort!.postMessage("closing", []);
      }
    },
    installTaskContext: () => {},
    onIdle: () => {
      idleCount++;
      assert.equal(closed, 2, "Idle requires every admitted resource close to settle");
      scheduleWorkerIdleGc();
      idle.resolve();
    },
  },
);
parentPort!.on("message", (message) => {
  if (message === "release") {
    firstRelease.resolve();
  }
});
parentPort!.postMessage("ready", []);
await idle.promise;
assert.equal(idleCount, 1);
assert.ok(collectIdle, "Released resource payload must schedule idle collection");
const control = new WeakRef({ unowned: true });
// A native callback lets the completed resource-close frame release its references.
await new Promise<void>((resolve) => {
  setImmediate(() => {
    collectIdle!();
    setImmediate(resolve);
  });
});
assert.equal(released.deref(), undefined, "Closed resource payload must collect");
assert.equal(control.deref(), undefined, "Unowned control must collect");
assert.equal(heldRef.deref(), held, "Still-owned payload must survive");
parentPort!.postMessage("collected", []);
