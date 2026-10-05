import assert from "node:assert/strict";
import path from "node:path";
import { acquireFileLock } from "../../infra/file-lock.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db-cache.js";
import { executeExistingOpenClawStateRead } from "../../state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { loadCronStore, saveCronStore } from "../store.js";
import {
  beginCronReceiptAuthorityClose,
  drainCronReceiptAuthority,
  observeCronReceiptAuthority,
  startCronReceiptAuthorityHost,
  withCronReceiptAuthorityMutation,
} from "./receipt-authority-owner.js";
import {
  claimCronRunReceiptForTest,
  makeCronReceiptJob,
} from "./run-receipt-store.test-support.js";

const stateDir = process.argv[2];
assert.ok(stateDir, "Expected the fixture's isolated state directory");
process.env.OPENCLAW_STATE_DIR = stateDir;
const storePath = path.join(stateDir, "cron", "jobs.json");
await saveCronStore(storePath, { version: 1, jobs: [makeCronReceiptJob("uncertain-launch")] });
const job = (await loadCronStore(storePath)).jobs[0]!;
const handle = claimCronRunReceiptForTest(storePath, job, 1);
const database = openOpenClawStateDatabase();
const context = captureOpenClawStateWorkerContext();
const command = {
  type: "cron.currentReceipt" as const,
  handle,
  includeJob: true,
  includeAvailability: true,
};
const reply = await executeExistingOpenClawStateRead(
  { path: context.admission.databasePath, env: context.environment },
  command,
  { context, current: true },
);
assert.ok(reply?.ok && reply.type === command.type);
const observation = observeCronReceiptAuthority(context, command, reply.facts);
await observation.prepared;
const use = await observation.acquireUse({ permission: "execution", assertCurrent() {} });
const nativeSettlement = createDeferredCore();
let launches = 0;
use.initiate(() => launches++, nativeSettlement.promise);
let mutated = false;
const queued = withCronReceiptAuthorityMutation(context, async () => {
  mutated = true;
});
const retained = /custody is retained.*[Rr]etire the Gateway process/;
const queuedRefusal = assert.rejects(queued, retained);
nativeSettlement.reject(new Error("synthetic native retirement uncertainty"));
await nativeSettlement.promise.catch(() => {});
assert.throws(() => use.initiate(() => launches++));
beginCronReceiptAuthorityClose();
process.stdout.write("draining after rejected native settlement\n");
await assert.rejects(drainCronReceiptAuthority(), retained);
await queuedRefusal;
await assert.rejects(
  observation.acquireUse({ permission: "execution", assertCurrent() {} }),
  retained,
);
assert.equal(mutated, false);
assert.equal(launches, 1);
await assert.rejects(closeOpenClawStateDatabaseAsync(), retained);
assert.equal(database.db.isOpen, true);
assert.throws(() => captureOpenClawStateWorkerContext(), /read admission is closed/);
assert.throws(() => startCronReceiptAuthorityHost(), retained);
await assert.rejects(
  acquireFileLock(`${context.admission.identity.canonicalPath}.cron-authority`, {
    retries: { retries: 0, factor: 1, minTimeout: 1, maxTimeout: 1 },
    stale: 0,
    staleRecovery: "remove-if-definitely-stale",
  }),
  { code: "file_lock_timeout" },
);
// The failed native owner must survive orderly close; only this disposable process retires it.
process.stdout.write("retained-native-custody\n", () => process.exit(0));
