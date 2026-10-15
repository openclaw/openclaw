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
const context = new AsyncLocalStorage<QueueTimerCaller>();

class QueueTimerCaller {
  readonly prompt = Buffer.alloc(1024 * 1024, 1);
  constructor(readonly label: string | undefined) {}
}

async function completedCaller(run: () => unknown) {
  const caller = new QueueTimerCaller(resource);
  const references = [new WeakRef(caller), new WeakRef(caller.prompt)];
  await context.run(caller, run);
  return references;
}

type Fixture = {
  references: WeakRef<object>[];
  assertAlive: () => void;
  reuse: () => Promise<void>;
  close: () => Promise<void>;
};

async function queueFixture(): Promise<Fixture> {
  const queue = new BoundedSerialQueue({ maxPendingCount: 2, maxPendingWeight: 2 });
  const stores = new Map<string, StoreWriterQueue>();
  const lane = "retention:queue";
  const run = async (fn: () => Promise<void>) => {
    if (resource === "store-drain") {
      await runQueuedStoreWrite({ queues: stores, storePath: root, label: resource, fn });
    } else if (resource === "command-drain") {
      await enqueueCommandInLane(lane, fn);
    } else {
      const accepted = queue.enqueue(fn);
      assert.ok(accepted.accepted);
      await accepted.completion;
    }
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
  return {
    references,
    assertAlive: () => {
      if (resource === "store-drain") {
        assert.ok(stores.get(root)?.drainPromise, "The same store drain must remain active");
      } else if (resource === "command-drain") {
        assert.equal(getQueueSize(lane), 1, "The second command must retain its active slot");
      } else {
        assert.equal(queue.isIdle, false);
      }
    },
    reuse: async () => {
      await finish();
      await run(async () => assert.equal(context.getStore(), undefined));
    },
    close: finish,
  };
}

async function timerFixture(): Promise<Fixture> {
  const timers: WeakRef<object>[] = [];
  const hook = createHook({
    init(_id, type, _trigger, value) {
      if (type === "Timeout") {
        timers.push(new WeakRef(value));
      }
    },
  });
  const assertAlive = () => {
    assert.ok(
      timers.some((timer) => timer.deref()),
      "A real native timeout must remain alive",
    );
  };
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
  return {
    references,
    assertAlive,
    reuse: async () => {
      assert.equal(await readFile(uploadedPath, "utf8"), "retention fixture");
      await ensureTerminalUploadCleanup({ tempRoot: root });
      assert.equal(await readFile(uploadedPath, "utf8"), "retention fixture");
    },
    close: async () => {
      await rm(path.dirname(uploadedPath), { recursive: true, force: true });
      await ensureTerminalUploadCleanup({ tempRoot: root });
    },
  };
}

const fixture = resource === "terminal" ? await timerFixture() : await queueFixture();
try {
  await collectForRetentionCheck(`queue-${resource}`);
  fixture.assertAlive();
  assert.equal(
    fixture.references.filter((reference) => reference.deref()).length,
    0,
    `The live ${resource} owner retained a completed caller`,
  );
  await fixture.reuse();
  process.stdout.write(
    JSON.stringify({ resource, collected: fixture.references.length, reused: true }),
  );
} finally {
  await fixture.close();
}
