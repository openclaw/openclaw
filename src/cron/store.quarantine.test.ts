import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  loadCronQuarantinedJobs,
  loadCronStore,
  saveCronJobsStore,
  saveCronQuarantinedJobs,
  saveCronStore,
} from "./store.js";
import { makeStore } from "./store.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function makeStorePath() {
  return { storePath: path.join(tempDirs.make("openclaw-cron-quarantine-"), "cron", "jobs.json") };
}

function resolveLegacyCronQuarantinePath(storePath: string): string {
  return storePath.replace(/\.json$/, "-quarantine.json");
}

async function expectPathMissing(targetPath: string): Promise<void> {
  await expect(fs.stat(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("cron quarantine", () => {
  it("stores quarantined jobs in SQLite and preserves the first recovery timestamp", async () => {
    const { storePath } = makeStorePath();
    const quarantinePath = resolveLegacyCronQuarantinePath(storePath);
    const entry = { sourceIndex: 0, reason: "missing-schedule", job: { id: "same-row" } };

    saveCronQuarantinedJobs({ storePath, nowMs: 100, entries: [entry] });
    saveCronQuarantinedJobs({ storePath, nowMs: 200, entries: [entry] });

    expect(await loadCronQuarantinedJobs(storePath)).toEqual([{ ...entry, quarantinedAtMs: 100 }]);
    await expectPathMissing(quarantinePath);
  });

  it("rolls back quarantine records when the cron row update cannot commit", async () => {
    const { storePath } = makeStorePath();
    const store = makeStore("atomic-quarantine-job", true);
    await saveCronStore(storePath, store);
    const database = openOpenClawStateDatabase().db;
    database.exec(
      "CREATE TRIGGER fail_cron_quarantine_update BEFORE UPDATE ON cron_jobs BEGIN SELECT RAISE(ABORT, 'cron update rejected'); END",
    );
    try {
      await expect(
        saveCronJobsStore(storePath, store, {
          quarantine: {
            nowMs: 123,
            entries: [{ sourceIndex: 0, reason: "invalid-schedule", job: { id: "bad-row" } }],
          },
        }),
      ).rejects.toThrow("cron update rejected");
      expect(await loadCronQuarantinedJobs(storePath)).toEqual([]);
      expect((await loadCronStore(storePath)).jobs.map((job) => job.id)).toEqual([
        "atomic-quarantine-job",
      ]);
    } finally {
      database.exec("DROP TRIGGER fail_cron_quarantine_update");
    }
  });

  it("rolls back quarantine deletion when the restored cron row cannot commit", async () => {
    const { storePath } = makeStorePath();
    const store = makeStore("atomic-recovery-job", true);
    await saveCronStore(storePath, store);
    const entry = {
      sourceIndex: 0,
      reason: "invalid-schedule" as const,
      job: { id: "atomic-recovery-job" },
    };
    saveCronQuarantinedJobs({ storePath, nowMs: 123, entries: [entry] });
    const database = openOpenClawStateDatabase().db;
    database.exec(
      "CREATE TRIGGER fail_cron_recovery_update BEFORE UPDATE ON cron_jobs BEGIN SELECT RAISE(ABORT, 'cron recovery rejected'); END",
    );
    try {
      await expect(
        saveCronJobsStore(storePath, store, { deleteQuarantineEntries: [entry] }),
      ).rejects.toThrow("cron recovery rejected");
      expect(await loadCronQuarantinedJobs(storePath)).toEqual([
        { ...entry, quarantinedAtMs: 123 },
      ]);
      expect((await loadCronStore(storePath)).jobs.map((job) => job.id)).toEqual([
        "atomic-recovery-job",
      ]);
    } finally {
      database.exec("DROP TRIGGER fail_cron_recovery_update");
    }

    await saveCronJobsStore(storePath, store, { deleteQuarantineEntries: [entry] });
    expect(await loadCronQuarantinedJobs(storePath)).toEqual([]);
  });
});
