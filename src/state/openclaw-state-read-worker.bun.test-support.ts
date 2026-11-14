import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import * as sqliteRuntime from "../infra/bun-sqlite-library.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { getTrackedWorkerLifecycleSnapshot } from "../infra/worker-cpu.js";
import * as stateCache from "./openclaw-state-db-cache.js";
import { captureOpenClawStateReadSource } from "./openclaw-state-read-worker.js";

const root = process.argv[2] ?? "";
assert(root && process.versions.bun);
sqliteRuntime.ensureSqliteLibrarySelected();
const { explicitSqliteCloseReleasesNativeResources: capable } =
  process.argv[3] === "admitted"
    ? await sqliteRuntime.initializeSqliteRuntimeCapabilities()
    : sqliteRuntime.getSqliteRuntimeCapabilities();
const { workerCount: admissionCount, workerLifecycle: admissionWorkers } =
  getTrackedWorkerLifecycleSnapshot();
for (const worker of admissionWorkers) {
  assert.deepEqual([worker.script, worker.started], ["other", 1], "one builtins-only probe");
}
assert.ok(
  admissionCount === 0 || (!capable && admissionCount === 1 && admissionWorkers.length === 1),
  "only conservative admission may retain one private probe",
);
const filename = path.join(root, "state.sqlite");
const privateLocation = path.join(root, "private.sqlite");
function seed(location: string, sql: string) {
  using database = openNodeSqliteDatabase(location);
  database.exec(sql);
}
for (const location of [filename, privateLocation]) {
  seed(
    location,
    "CREATE TABLE config_machine_state(state_key TEXT PRIMARY KEY, value_json TEXT, updated_at_ms INTEGER); INSERT INTO config_machine_state VALUES ('nodeHost.config', '1', 1)",
  );
}

const READER = "openclaw-state-read.worker.js";
const SUPERVISOR = "worker-native-lifecycle.worker.js";
function assertLifecycle(expected: [number, number], message: string) {
  const snapshot = getTrackedWorkerLifecycleSnapshot();
  const rows = snapshot.workerLifecycle.map(({ script, started, retired }) => ({
    script,
    started,
    retired: retired.reduce((sum, { count }) => sum + count, 0),
  }));
  const worker = rows.find(({ script }) => script === READER);
  assert(worker);
  const probes = rows.filter(({ script }) => script !== READER && script !== SUPERVISOR);
  // Conservative admission can finish while its unreferenced probe is still retiring.
  assert.deepEqual(
    probes.map(({ script, started }) => [script, started]),
    admissionWorkers.map(({ script, started }) => [script, started]),
  );
  assert.deepEqual(
    rows.find(({ script }) => script === SUPERVISOR),
    { script: SUPERVISOR, started: 1, retired: 0 },
  );
  assert.deepEqual([worker.started, worker.retired], expected, message);
}

async function read(location = filename, checkFreshAdmission = false) {
  const admission = stateCache.captureOpenClawStateDatabaseReadAdmission(filename);
  const transport = captureOpenClawStateReadSource().createTransport({ type: "nodeHost.config" });
  try {
    const outcome = await transport.startRead(
      {
        context: { environment: { OPENCLAW_STATE_DIR: root }, admission },
        location,
        checkFreshAdmission,
      },
      { signal: new AbortController().signal, assertCurrent: admission.assertCurrent },
    );
    if ("error" in outcome) {
      throw outcome.error;
    }
    assert(outcome.value.ok && outcome.value.type === "nodeHost.config");
    assert.equal(outcome.value.row?.updated_at_ms, 1);
  } finally {
    await transport.startClose();
  }
}

try {
  await read();
  await read();
  assertLifecycle([1, 0], "successful reads reuse");
  await stateCache.closeOpenClawStateDatabaseByPathAsync(filename);
  assertLifecycle([1, capable ? 0 : 1], "host close joins native cleanup");
  await read();
  assertLifecycle([capable ? 1 : 2, capable ? 0 : 1], "closed reader reopens");
  await read(privateLocation);
  assertLifecycle([capable ? 1 : 2, capable ? 0 : 2], "internal close settles");
  fs.mkdirSync(path.join(root, "state"));
  seed(path.join(root, "state", "openclaw-quarantine.sqlite"), "PRAGMA user_version = 0");
  await read(filename, true);
  assertLifecycle([capable ? 1 : 3, capable ? 0 : 3], "admission close settles");
  console.log(`Bun shared-state worker reuse and native cleanup passed (capable=${capable})`);
} finally {
  await stateCache.closeOpenClawStateDatabaseAsync();
}
