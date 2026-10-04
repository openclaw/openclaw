import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync } from "node:fs";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db-cache.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { getOpenClawStateWorkerOwner } from "../state/openclaw-state-worker-owner.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import { collectForRetentionCheck } from "../test-utils/retention.js";
import { removeTempDirectoryAsync } from "./sqlite-readonly-location-cleanup.js";
import { allocateWorkerOwnedSqliteSnapshotDirectory } from "./sqlite-snapshot-staging-allocation.js";
import { captureSqliteSnapshotStagingOwner } from "./sqlite-snapshot-staging-owner.js";
import {
  getSqliteWorkerActorIdentity,
  isSqliteWorkerStoreAvailable,
} from "./sqlite-worker-store.js";

const [root, scenario] = process.argv.slice(2);
assert.ok(root, "SQLite lifecycle retention requires its temporary directory");
const callerContext = new AsyncLocalStorage<object>();

class SqliteStagingCaller {
  prompt = Buffer.alloc(1024 * 1024, 1);
}
class SqliteStateOpeningCaller {
  prompt = Buffer.alloc(1024 * 1024, 2);
}
class SqliteStateOpeningAuthority {
  prompt = Buffer.alloc(1024 * 1024, 3);
}

async function assertCollected(references: WeakRef<object>[]) {
  await collectForRetentionCheck(`sqlite-${scenario}`);
  assert.equal(
    references.filter((reference) => reference.deref()).length,
    0,
    `${scenario} retained completed caller state`,
  );
}

function captureStagingCaller() {
  const caller = new SqliteStagingCaller();
  return {
    owner: callerContext.run(caller, captureSqliteSnapshotStagingOwner),
    references: [new WeakRef(caller), new WeakRef(caller.prompt)],
  };
}

async function checkStaging() {
  const { owner, references } = captureStagingCaller();
  // Per-request custody has its own lifetime; this caller only creates the reusable owner.
  const directory = await allocateWorkerOwnedSqliteSnapshotDirectory(root!, false);
  try {
    assert.ok(
      existsSync(directory.directory),
      "The real native resource must allocate a directory",
    );
    await assertCollected(references);
    assert.equal(captureSqliteSnapshotStagingOwner(), owner);
    const second = await allocateWorkerOwnedSqliteSnapshotDirectory(root!, false);
    assert.notEqual(second.directory, directory.directory);
    assert.equal(await removeTempDirectoryAsync(second.directory), true);
  } finally {
    assert.equal(await removeTempDirectoryAsync(directory.directory), true);
  }
}

const readCommand = {
  type: "deviceIdentity.read",
  input: { identityKey: "lifecycle-retention" },
} as const;

async function completeStateOpening() {
  const caller = new SqliteStateOpeningCaller();
  const authority = new SqliteStateOpeningAuthority();
  const context = captureOpenClawStateWorkerContext();
  const references = [
    new WeakRef(caller),
    new WeakRef(caller.prompt),
    new WeakRef(authority),
    new WeakRef(authority.prompt),
  ];
  await callerContext.run(caller, async () => {
    const result = await runOpenClawStateWorkerOperation(
      context,
      (scope) => scope.execute(readCommand),
      {
        assertCurrent() {
          assert.equal(callerContext.getStore(), caller, "Admission must retain current authority");
          assert.equal(authority.prompt.byteLength, 1024 * 1024);
        },
      },
    );
    assert.equal(result, null);
  });
  return { references, context };
}

async function checkStateOpening() {
  try {
    const { references, context } = await completeStateOpening();
    const owner = getOpenClawStateWorkerOwner();
    const store = await owner.open(context);
    assert.ok(store);
    const actor = getSqliteWorkerActorIdentity(store);
    await assertCollected(references);
    assert.equal(isSqliteWorkerStoreAvailable(store), true);
    assert.equal(await owner.open(context), store);
    assert.equal(getSqliteWorkerActorIdentity(store), actor);
    assert.equal(
      await runOpenClawStateWorkerOperation(context, (scope) => scope.execute(readCommand)),
      null,
    );
  } finally {
    await closeOpenClawStateDatabaseAsync();
  }
}

if (scenario === "snapshot-staging") {
  await checkStaging();
} else if (scenario === "state-opening") {
  await checkStateOpening();
} else {
  throw new Error(`Unknown SQLite lifecycle retention scenario: ${scenario}`);
}
process.stdout.write(JSON.stringify({ scenario, collected: true, reused: true }));
