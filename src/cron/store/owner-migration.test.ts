import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { makeCronJob } from "../delivery.test-helpers.js";
import { cronStoreKey } from "./key.js";
import { materializeCronJobsStoreOwners } from "./owner-migration.js";
import {
  loadedCronStoreFromRows,
  loadCronRows,
  readCronStoreEpoch,
  replaceCronRows,
  upsertCronJobRow,
} from "./row-codec.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("cron row owner migration", () => {
  it("materializes a valid row inserted after the caller snapshot", async () => {
    const root = tempDirs.make("openclaw-cron-owner-migration-");
    const env = { OPENCLAW_STATE_DIR: root } as NodeJS.ProcessEnv;
    const storePath = path.join(root, "cron", "jobs.json");
    const storeKey = cronStoreKey(path.resolve(storePath));
    const handle = openOpenClawStateDatabase({ env });
    const baselineJob = makeCronJob({ id: "baseline" });
    const lateJob = makeCronJob({ id: "late-row" });
    try {
      replaceCronRows(
        handle.db,
        storeKey,
        { version: 1, jobs: [baselineJob] },
        { bumpStoreEpoch: true },
      );
      const loaded = loadedCronStoreFromRows(
        loadCronRows(handle.db, storeKey),
        readCronStoreEpoch(handle.db, storeKey),
      );

      upsertCronJobRow(handle.db, storeKey, lateJob, 1);
      // Simulate an epoch-blind pre-upgrade writer: the valid row appears after load
      // without invalidating the caller's optimistic migration epoch.
      handle.db
        .prepare("UPDATE cron_store_epochs SET store_epoch = ? WHERE store_key = ?")
        .run(loaded.storeEpoch, storeKey);

      await expect(
        materializeCronJobsStoreOwners({
          storePath,
          legacyDefaultAgentId: "ops",
          records: loaded.store.jobs,
          legacyImportedJobIds: new Set(),
          expectedStoreEpoch: loaded.storeEpoch,
          env,
        }),
      ).resolves.toEqual({ matched: true, rewritten: 2 });
      expect(loadCronRows(handle.db, storeKey).map((row) => [row.job_id, row.agent_id])).toEqual([
        ["baseline", "ops"],
        ["late-row", "ops"],
      ]);
    } finally {
      handle.walMaintenance.close();
      handle.db.close();
    }
  });
});
