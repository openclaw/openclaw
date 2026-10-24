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

it("rejects unrecognized historical quarantine files without modifying them", async () => {
  const { storePath } = await makeStorePath();
  const quarantinePath = storePath.replace(/\.json$/, "-quarantine.json");
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(
    quarantinePath,
    JSON.stringify({ version: 2, jobs: [{ reason: "old-shape", raw: "keep-me" }] }),
  );

  await expect(loadLegacyCronQuarantineForMigration(storePath)).rejects.toThrow(
    /Unsupported cron quarantine file shape/,
  );

  expect(JSON.parse(await fs.readFile(quarantinePath, "utf-8"))).toMatchObject({
    jobs: [{ raw: "keep-me" }],
  });
});

it("rejects malformed UTF-8 historical quarantine without modifying its bytes", async () => {
  const { storePath } = await makeStorePath();
  const quarantinePath = storePath.replace(/\.json$/, "-quarantine.json");
  const bytes = Buffer.from('{"version":1,"jobs":[{"reason":"\x80","raw":"keep-me"}]}', "latin1");
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(quarantinePath, bytes);

  await expect(loadLegacyCronQuarantineForMigration(storePath)).rejects.toThrow(
    "must be valid UTF-8",
  );
  expect(await fs.readFile(quarantinePath)).toEqual(bytes);
});

it("preserves recovery rows when maintenance authority expires before worker dispatch", async () => {
  const { storePath } = await makeStorePath();
  const retained = { sourceIndex: 0, reason: "missing-schedule", job: { id: "retained" } };
  await saveCronQuarantinedJobs({ storePath, nowMs: 100, entries: [retained] });
  const database = openOpenClawStateDatabase().db;
  const schemaVersion = database.prepare("PRAGMA schema_version").get();
  let current = true;
  let witnessed = false;
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
      witnessed = true;
      current = false;
      return runWorkerOperation(context, operation, options);
    });
  try {
    await expect(
      scope.run(() =>
        saveCronQuarantinedJobs({
          storePath,
          nowMs: 200,
          entries: [{ sourceIndex: 1, reason: "missing-schedule", job: { id: "refused" } }],
        }),
      ),
    ).rejects.toThrow("Quarantine maintenance owner revoked");
    expect(witnessed).toBe(true);
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
  const entry = { sourceIndex: 0, reason: "missing-schedule", job: { id: "same-row" } };

  const saving = saveCronQuarantinedJobs({ storePath, nowMs: 100, entries: [entry] });
  entry.job.id = "changed-after-call";
  await saving;
  entry.job.id = "same-row";
  await saveCronQuarantinedJobs({ storePath, nowMs: 200, entries: [entry] });

  expect(await loadCronQuarantinedJobs(storePath)).toEqual([{ ...entry, quarantinedAtMs: 100 }]);
  await expectPathMissing(storePath.replace(/\.json$/, "-quarantine.json"));
});

it.each([false, true])(
  "rolls back quarantine changes on failed row update (recovery=%s)",
  async (recovery) => {
    const { storePath } = await makeStorePath();
    const jobId = recovery ? "atomic-recovery-job" : "atomic-quarantine-job";
    const store = makeStore(jobId, true);
    await saveCronJobsStore(storePath, store);
    const entry = {
      sourceIndex: 0,
      reason: "invalid-schedule" as const,
      job: { id: recovery ? jobId : "bad-row" },
    };
    if (recovery) {
      await saveCronQuarantinedJobs({ storePath, nowMs: 123, entries: [entry] });
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
      expect((await loadCronStore(storePath)).jobs.map((job) => job.id)).toEqual([jobId]);
    } finally {
      database.exec("DROP TRIGGER fail_cron_recovery_update");
    }

    if (recovery) {
      await saveCronJobsStore(storePath, store, options);
      expect(await loadCronQuarantinedJobs(storePath)).toEqual([]);
    }
  },
);
