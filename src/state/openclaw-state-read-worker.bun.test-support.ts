import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  ensureSqliteLibrarySelected,
  getSqliteRuntimeCapabilities,
  initializeSqliteRuntimeCapabilities,
} from "../infra/bun-sqlite-library.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { getTrackedWorkerLifecycleSnapshot } from "../infra/worker-cpu.js";
import {
  captureOpenClawStateDatabaseReadAdmission,
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseByPathAsync,
} from "./openclaw-state-db-cache.js";
import { captureOpenClawStateReadSource } from "./openclaw-state-read-worker.js";

const root = process.argv[2] ?? "";
assert(root);
assert(process.versions.bun);
ensureSqliteLibrarySelected();
const { explicitSqliteCloseReleasesNativeResources: capable } =
  process.argv[3] === "admitted"
    ? await initializeSqliteRuntimeCapabilities()
    : getSqliteRuntimeCapabilities();
const admissionWorkers = getTrackedWorkerLifecycleSnapshot();
for (const worker of admissionWorkers.workerLifecycle) {
  assert.equal(worker.script, "other", "the builtins-only probe uses native Worker tracking");
  assert.equal(worker.started, 1, "admission starts at most one private probe");
}
assert.ok(
  admissionWorkers.workerCount === 0 ||
    (!capable &&
      admissionWorkers.workerCount === 1 &&
      admissionWorkers.workerLifecycle.length === 1),
  "only conservative admission may retain one private probe",
);
const filename = path.join(root, "state.sqlite");
const privateLocation = path.join(root, "private.sqlite");
for (const location of [filename, privateLocation]) {
  const seed = openNodeSqliteDatabase(location);
  seed.exec(
    "CREATE TABLE config_machine_state(state_key TEXT PRIMARY KEY, value_json TEXT, updated_at_ms INTEGER); INSERT INTO config_machine_state VALUES ('nodeHost.config', '1', 1)",
  );
  seed.close();
}

function lifecycle() {
  const snapshot = getTrackedWorkerLifecycleSnapshot();
  const worker = snapshot.workerLifecycle.find(
    ({ script }) => script === "openclaw-state-read.worker.js",
  );
  const supervisor = snapshot.workerLifecycle.find(
    ({ script }) => script === "worker-native-lifecycle.worker.js",
  );
  assert(worker);
  assert(supervisor);
  const probes = snapshot.workerLifecycle.filter(
    ({ script }) =>
      script !== "openclaw-state-read.worker.js" && script !== "worker-native-lifecycle.worker.js",
  );
  // Conservative admission can finish while its unreferenced probe is still retiring.
  assert.deepEqual(
    probes.map(({ script, started }) => ({ script, started })),
    admissionWorkers.workerLifecycle.map(({ script, started }) => ({ script, started })),
    "only the SQL reader and its retained supervisor start after admission",
  );
  const retired = worker.retired.reduce((total, { count }) => total + count, 0);
  const supervisorRetired = supervisor.retired.reduce((total, { count }) => total + count, 0);
  assert.deepEqual(
    { started: supervisor.started, retired: supervisorRetired },
    { started: 1, retired: 0 },
    "the unbound SQL-free supervisor remains until process exit",
  );
  const live = worker.started - retired;
  const liveProbes = probes.reduce(
    (total, probe) =>
      total +
      probe.started -
      probe.retired.reduce((count, retirement) => count + retirement.count, 0),
    0,
  );
  assert.equal(snapshot.workerCount, live + supervisor.started - supervisorRetired + liveProbes);
  return { started: worker.started, retired, live };
}

async function read(location = filename, checkFreshAdmission = false) {
  const admission = captureOpenClawStateDatabaseReadAdmission(filename);
  const transport = captureOpenClawStateReadSource().createTransport({ type: "nodeHost.config" });
  try {
    const outcome = await transport.startRead(
      {
        context: { environment: { OPENCLAW_STATE_DIR: root }, admission },
        location,
        checkFreshAdmission,
      },
      { signal: new AbortController().signal, assertCurrent: admission.assertCurrent },
    ).result;
    if ("error" in outcome) {
      throw outcome.error;
    }
    assert(outcome.value.ok && outcome.value.type === "nodeHost.config");
    assert.equal(outcome.value.row?.updated_at_ms, 1);
  } finally {
    await transport.startClose().result;
  }
}

try {
  for (let index = 0; index < 5; index++) {
    await read();
  }
  assert.deepEqual(lifecycle(), { started: 1, retired: 0, live: 1 }, "successful reads reuse");
  await closeOpenClawStateDatabaseByPathAsync(filename);
  assert.deepEqual(
    lifecycle(),
    { started: 1, retired: capable ? 0 : 1, live: capable ? 1 : 0 },
    "host close joins native cleanup and retains capable workers",
  );
  await read();
  assert.deepEqual(
    lifecycle(),
    { started: capable ? 1 : 2, retired: capable ? 0 : 1, live: 1 },
    "closed reader reopens",
  );
  await read(privateLocation);
  assert.deepEqual(
    lifecycle(),
    { started: capable ? 1 : 2, retired: capable ? 0 : 2, live: capable ? 1 : 0 },
    "internal close settles",
  );
  fs.mkdirSync(path.join(root, "state"));
  const quarantine = openNodeSqliteDatabase(path.join(root, "state", "openclaw-quarantine.sqlite"));
  quarantine.exec("PRAGMA user_version = 0");
  quarantine.close();
  await read(filename, true);
  assert.deepEqual(
    lifecycle(),
    { started: capable ? 1 : 3, retired: capable ? 0 : 3, live: capable ? 1 : 0 },
    "admission close settles",
  );
  console.log(`Bun shared-state worker reuse and native cleanup passed (capable=${capable})`);
} finally {
  await closeOpenClawStateDatabaseAsync();
}
