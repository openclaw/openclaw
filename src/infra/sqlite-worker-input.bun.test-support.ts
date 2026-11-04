import assert from "node:assert/strict";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { withAgentDatabaseMaintenanceLease } from "../state/openclaw-agent-db-maintenance-lease.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { SqliteWorkerBroker } from "./sqlite-worker-broker.js";
import type { SqliteWorkerRequest } from "./sqlite-worker-contract.js";
import type { FixtureOperations } from "./sqlite-worker-store.test-support.js";

assert.ok(process.versions.bun, "this regression must execute in Bun");
const home = process.argv[2];
assert.ok(home, "the fixture requires its private home directory");
const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(home, "state") };
const broker = new SqliteWorkerBroker();
// oxlint-disable-next-line typescript/unbound-method -- call preserves the intercepted Worker receiver.
const nativePost = Worker.prototype.postMessage;
const dispatched: Uint8Array[] = [];
Worker.prototype.postMessage = function (request: SqliteWorkerRequest, transfers) {
  if (typeof request === "object" && request !== null && "input" in request) {
    dispatched.push(request.input);
  }
  if (
    typeof request === "object" &&
    request !== null &&
    request.type === "open" &&
    request.preparation
  ) {
    dispatched.push(request.preparation);
  }
  return nativePost.call(this, request, transfers);
};
try {
  openOpenClawStateDatabase({ env });
  await withAgentDatabaseMaintenanceLease({ env, processBound: true }, async (lease) => {
    lease.assertOwned();
  });
  const store = await broker.open<FixtureOperations>(
    {
      databasePath: path.join(home, "store.sqlite"),
      moduleUrl: new URL("./sqlite-worker-store.test-support.ts", import.meta.url),
      input: undefined,
    },
    undefined,
    undefined,
    { preparation: { marker: "prepared" } },
  );
  assert.ok(store);
  const values = ["inline", "x".repeat(36 * 1024 * 1024)];
  for (const value of values) {
    assert.equal(
      (await store.execute({ type: "append", input: { value } })).writes,
      values.indexOf(value) + 1,
    );
  }
  assert.deepEqual(await store.execute({ type: "read", input: undefined }), values);
  await store.close();
  assert.ok(dispatched.length > 5);
  assert.ok(dispatched.every((bytes) => bytes.byteLength === 0));
} finally {
  Worker.prototype.postMessage = nativePost;
  await broker.close();
  closeOpenClawStateDatabaseForTest();
}
