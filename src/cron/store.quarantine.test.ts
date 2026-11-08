import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { loadLegacyCronQuarantineForMigration } from "../commands/doctor/cron/legacy-quarantine-migration.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import {
  loadCronQuarantinedJobs,
  loadCronStore,
  saveCronJobsStore,
  saveCronQuarantinedJobs,
} from "./store.js";
import { createStorePathFixture, expectPathMissing, makeStore } from "./store.test-support.js";

const makeStorePath = createStorePathFixture();
const recoveryEntry = (id: string, reason = "missing-schedule", sourceIndex = 0) => ({
  sourceIndex,
  reason,
  job: { id },
});
const saveQuarantine = (storePath: string, entry: ReturnType<typeof recoveryEntry>, nowMs = 100) =>
  saveCronQuarantinedJobs({ storePath, nowMs, entries: [entry] });

it.each([
  ["unrecognized shape", Buffer.from('{"version":2}'), "Unsupported cron quarantine file shape"],
  [
    "malformed UTF-8",
    Buffer.from('{"version":1,"jobs":[{"reason":"\x80"}]}', "latin1"),
    "must be valid UTF-8",
  ],
] as const)(
  "rejects %s historical quarantine without modifying its bytes",
  async (_name, bytes, error) => {
    const { storePath } = await makeStorePath();
    const quarantinePath = storePath.replace(/\.json$/, "-quarantine.json");
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(quarantinePath, bytes);
    await expect(loadLegacyCronQuarantineForMigration(storePath)).rejects.toThrow(error);
    expect(await fs.readFile(quarantinePath)).toEqual(bytes);
  },
);

it("preserves recovery rows when maintenance authority expires before worker dispatch", async () => {
  const { storePath } = await makeStorePath();
  const retained = recoveryEntry("retained");
  await saveQuarantine(storePath, retained);
  const database = openOpenClawStateDatabase().db;
  const schemaVersion = database.prepare("PRAGMA schema_version").get();
  let current = true;
  const scope = createOpenClawDatabaseMaintenanceScope({
    assertOwnerCurrent: () => {
      if (!current) {
        throw new Error("Quarantine maintenance owner revoked");
      }
    },
  });
  const runWorkerOperation = stateWorker.runOpenClawStateWorkerOperation;
  const admission = vi
    .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
    .mockImplementation((context, operation, options) => {
      current = false;
      return runWorkerOperation(context, operation, options);
    });
  try {
    await expect(
      scope.run(() =>
        saveQuarantine(storePath, recoveryEntry("refused", "missing-schedule", 1), 200),
      ),
    ).rejects.toThrow("Quarantine maintenance owner revoked");
    expect(await loadCronQuarantinedJobs(storePath)).toEqual([
      { ...retained, quarantinedAtMs: 100 },
    ]);
    expect(database.prepare("PRAGMA schema_version").get()).toEqual(schemaVersion);
  } finally {
    admission.mockRestore();
    current = true;
    await scope.close();
  }
});

it("captures quarantine input and preserves the first recovery timestamp", async () => {
  const { storePath } = await makeStorePath();
  const entry = recoveryEntry("same-row");

  const saving = saveQuarantine(storePath, entry);
  entry.job.id = "changed-after-call";
  await saving;
  entry.job.id = "same-row";
  await saveQuarantine(storePath, entry, 200);

  expect(await loadCronQuarantinedJobs(storePath)).toEqual([{ ...entry, quarantinedAtMs: 100 }]);
  await expectPathMissing(storePath.replace(/\.json$/, "-quarantine.json"));
});

it.each([false, true])(
  "rolls back quarantine changes on failed row update (recovery=%s)",
  async (recovery) => {
    const { storePath } = await makeStorePath();
    const store = makeStore("job", true);
    await saveCronJobsStore(storePath, store);
    const entry = recoveryEntry(recovery ? "job" : "bad-row", "invalid-schedule");
    if (recovery) {
      await saveQuarantine(storePath, entry, 123);
    }
    const options = recovery
      ? { deleteQuarantineEntries: [entry] }
      : { quarantine: { nowMs: 123, entries: [entry] } };
    const database = openOpenClawStateDatabase().db;
    database.exec(
      "CREATE TRIGGER fail_cron_recovery_update BEFORE UPDATE ON cron_jobs BEGIN SELECT RAISE(ABORT, 'cron recovery rejected'); END",
    );
    try {
      await expect(saveCronJobsStore(storePath, store, options)).rejects.toThrow(
        "cron recovery rejected",
      );
      expect(await loadCronQuarantinedJobs(storePath)).toEqual(
        recovery ? [{ ...entry, quarantinedAtMs: 123 }] : [],
      );
      expect((await loadCronStore(storePath)).jobs.map((job) => job.id)).toEqual(["job"]);
    } finally {
      database.exec("DROP TRIGGER fail_cron_recovery_update");
    }

    if (recovery) {
      await saveCronJobsStore(storePath, store, options);
      expect(await loadCronQuarantinedJobs(storePath)).toEqual([]);
    }
  },
);
