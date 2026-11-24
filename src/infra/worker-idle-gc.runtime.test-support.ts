import assert from "node:assert/strict";
import { parentPort } from "node:worker_threads";
import { collectForRetentionCheck } from "../test-utils/retention.js";
import { scheduleWorkerIdleGc } from "./worker-idle-gc.js";

let collectIdle: (() => void) | undefined;
// Capture the real owner's timer without waiting; keep its native cancellation token.
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

const held = Buffer.alloc(64 * 1024 * 1024, 73);
const heldRef = new WeakRef(held);
const owner: { payload?: Buffer } = { payload: Buffer.alloc(64 * 1024 * 1024, 37) };
const released = new WeakRef(owner.payload!);
// Publish the live allocation in Bun's counters before testing the idle growth threshold.
await collectForRetentionCheck("held-worker-payload", 1);
owner.payload = undefined;
const control = new WeakRef({ unowned: true });
scheduleWorkerIdleGc();
assert.ok(collectIdle, "Payload growth must schedule idle collection");
// Like the shared retention helper, collect from a native callback after this job unwinds.
await new Promise<void>((resolve) => {
  setImmediate(() => {
    collectIdle!();
    setImmediate(resolve);
  });
});
assert.equal(released.deref() === undefined, true, "Released worker payload must collect");
assert.equal(control.deref(), undefined, "Unowned control must collect");
assert.equal(heldRef.deref(), held, "Strongly held worker payload must survive");
parentPort!.postMessage("collected", []);
