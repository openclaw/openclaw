import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { setEnvironmentData } from "node:worker_threads";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { createSqliteSourceFenceAdmission } from "./sqlite-source-fence-admission.js";
import {
  FENCE_FIXTURE_ENV,
  type FenceFixtureOperations,
} from "./sqlite-source-fence.test-support.js";
import { SqliteWorkerBroker } from "./sqlite-worker-broker.js";
import { readDatabasePathIdentitySync } from "./sqlite-worker-identity.js";
import { observeSqliteWorkerCommittedFacts } from "./sqlite-worker-operation-admission.js";
import type { SqliteWorkerOperationSettlement } from "./sqlite-worker-operation-settlement.js";

assert.ok(process.versions.bun);
const root = process.argv[2];
assert.ok(root);
const barriers = new Int32Array(new SharedArrayBuffer(16));
setEnvironmentData(FENCE_FIXTURE_ENV, barriers.buffer);
const databases = ["source", "destination"].map((name) => {
  const filename = path.join(root, name + ".sqlite");
  const database = openNodeSqliteDatabase(filename);
  database.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE authority(id INTEGER PRIMARY KEY, revision INTEGER); INSERT INTO authority VALUES(1,1); CREATE TABLE requests(id TEXT PRIMARY KEY, revision INTEGER); CREATE TABLE lifecycles(id TEXT PRIMARY KEY);",
  );
  return {
    database,
    identity: { physical: readDatabasePathIdentitySync(filename), incarnation: randomUUID() },
  };
});
const [source, destination] = databases;
assert.ok(source);
assert.ok(destination);
const broker = new SqliteWorkerBroker();
// A late-created Bun worker has a younger hrtime origin than its host.
await sleep(1200);
try {
  const store = await broker.open<FenceFixtureOperations>({
    moduleUrl: new URL("./sqlite-source-fence.test-support.ts", import.meta.url),
    databasePath: destination.identity.physical.canonicalPath,
    input: { destination: destination.identity, source: source.identity },
    existingOnly: true,
  });
  assert.ok(store);
  const controller = new AbortController();
  const retained: Promise<SqliteWorkerOperationSettlement>[] = [];
  const owner = (identity: typeof source.identity) => ({
    identity,
    signal: controller.signal,
    assertCurrent() {},
    retain(operation: { settled: Promise<SqliteWorkerOperationSettlement> }) {
      retained.push(operation.settled);
    },
  });
  const receipts: unknown[] = [];
  const admission = createSqliteSourceFenceAdmission({
    destination: owner(destination.identity),
    sources: [owner(source.identity)],
    signal: controller.signal,
    deadlineNs: process.hrtime.bigint() + 200_000_000n,
  });
  const operation = broker.runOperation(
    store,
    (scope) =>
      scope.execute({
        type: "persist",
        input: { id: "expired", expectedRevision: 1, barrier: 0, pause: "validate" },
      }),
    undefined,
    undefined,
    (native) => {
      const grant = admission(native);
      observeSqliteWorkerCommittedFacts(grant.admission, (receipt) => receipts.push(receipt.facts));
      return grant;
    },
  );
  void operation.catch(() => {});
  while (Atomics.load(barriers, 0) < 1) {
    await Promise.race([
      Atomics.waitAsync(barriers, 0, 0).value,
      operation.then(() => {
        throw new Error("settled before validation");
      }),
    ]);
  }
  await sleep(300);
  Atomics.store(barriers, 1, 1);
  Atomics.notify(barriers, 1);
  const outcome = await operation.then(
    () => "committed",
    () => "rejected",
  );
  const settlements = await Promise.all(retained);
  const rows = destination.database.prepare("SELECT id FROM requests").all();
  console.log(JSON.stringify({ outcome, receipts, settlements, rows }));
  assert.equal(outcome, "rejected", "expired cross-store authority must not commit");
  assert.deepEqual(receipts, []);
  assert.deepEqual(rows, []);
  assert.deepEqual(destination.database.prepare("SELECT id FROM lifecycles").all(), []);
  assert.deepEqual(settlements, [{ kind: "completed" }, { kind: "completed" }]);
  source.database.exec("BEGIN IMMEDIATE; ROLLBACK");
} finally {
  Atomics.store(barriers, 1, 1);
  Atomics.notify(barriers, 1);
  await broker.close();
  for (const { database } of databases) {
    database.close();
  }
}
