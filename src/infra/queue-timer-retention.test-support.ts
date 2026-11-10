import assert from "node:assert/strict";
import { AsyncLocalStorage, createHook } from "node:async_hooks";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { enqueueCommandInLane, getQueueSize } from "../process/command-queue.js";
import { BoundedSerialQueue } from "../shared/bounded-serial-queue.js";
import { createDeferredCore } from "../shared/deferred.js";
import { runQueuedStoreWrite, type StoreWriterQueue } from "../shared/store-writer-queue.js";
import { collectForRetentionCheck } from "../test-utils/retention.js";
import { ensureTerminalUploadCleanup, stageTerminalUpload } from "./terminal-file-upload.js";

const [resource, rootArgument] = process.argv.slice(2);
assert.ok(rootArgument, "The retention fixture requires its owned temporary directory");
const root = rootArgument;
const context = new AsyncLocalStorage<{ label: string | undefined; prompt: Buffer }>();

async function completedCaller(run: () => unknown) {
  const caller = { label: resource, prompt: Buffer.alloc(1024 * 1024, 1) };
  const references = [new WeakRef(caller), new WeakRef(caller.prompt)];
  await context.run(caller, run);
  return references;
}

async function assertCollected(references: WeakRef<object>[], assertAlive: () => void) {
  await collectForRetentionCheck(`queue-${resource}`);
  assertAlive();
  assert.equal(
    references.filter((reference) => reference.deref()).length,
    0,
    `The live ${resource} owner retained a completed caller`,
  );
}

async function checkQueue() {
  const queue = new BoundedSerialQueue({ maxPendingCount: 2, maxPendingWeight: 2 });
  const stores = new Map<string, StoreWriterQueue>();
  const lane = "retention:queue";
  const run = (fn: () => Promise<void>) => {
    if (resource === "store-drain") {
      return runQueuedStoreWrite({ queues: stores, storePath: root, label: resource, fn });
    }
    if (resource === "command-drain") {
      return enqueueCommandInLane(lane, fn);
    }
    const accepted = queue.enqueue(fn);
    assert.ok(accepted.accepted);
    return accepted.completion;
  };
  const firstGate = createDeferredCore();
  const secondGate = createDeferredCore();
  const secondStarted = createDeferredCore();
  const first = completedCaller(() =>
    run(async () => {
      assert.equal(context.getStore()?.label, resource, "Work retains its own caller");
      await firstGate.promise;
    }),
  );
  const second = run(async () => {
    assert.equal(context.getStore(), undefined, "Later work must not inherit a caller");
    secondStarted.resolve();
    await secondGate.promise;
  });
  firstGate.resolve();
  const references = await first;
  await secondStarted.promise;
  const finish = async () => {
    secondGate.resolve();
    await second;
  };
  try {
    await assertCollected(references, () => {
      if (resource === "store-drain") {
        assert.ok(stores.get(root)?.drainPromise, "The same store drain must remain active");
      } else if (resource === "command-drain") {
        assert.equal(getQueueSize(lane), 1, "The second command must retain its active slot");
      } else {
        assert.equal(queue.isIdle, false);
      }
    });
    await finish();
    await run(async () => assert.equal(context.getStore(), undefined));
    return references.length;
  } finally {
    await finish();
  }
}

async function checkTimer() {
  const timers: WeakRef<object>[] = [];
  const hook = createHook({
    init(_id, type, _trigger, value) {
      if (type === "Timeout") {
        timers.push(new WeakRef(value));
      }
    },
  });
  let uploadedPath = "";
  hook.enable();
  let references: WeakRef<object>[];
  try {
    references = await completedCaller(async () => {
      const uploaded = await stageTerminalUpload(
        {
          name: "retention.txt",
          contentBase64: Buffer.from("retention fixture").toString("base64"),
          assertCommitAllowed: () => assert.equal(context.getStore()?.label, resource),
        },
        { tempRoot: root },
      );
      uploadedPath = uploaded.path;
    });
  } finally {
    hook.disable();
  }
  try {
    await assertCollected(references, () =>
      assert.ok(
        timers.some((timer) => timer.deref()),
        "A real native timeout must remain alive",
      ),
    );
    assert.equal(await readFile(uploadedPath, "utf8"), "retention fixture");
    await ensureTerminalUploadCleanup({ tempRoot: root });
    assert.equal(await readFile(uploadedPath, "utf8"), "retention fixture");
    return references.length;
  } finally {
    await rm(path.dirname(uploadedPath), { recursive: true, force: true });
    await ensureTerminalUploadCleanup({ tempRoot: root });
  }
}

const collected = resource === "terminal" ? await checkTimer() : await checkQueue();
process.stdout.write(JSON.stringify({ resource, collected, reused: true }));
