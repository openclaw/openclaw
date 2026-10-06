import { noteCronJobsStoreCommit } from "../../../src/cron/store.js";
import { cronStoreKey } from "../../../src/cron/store/key.js";
import { assertCronStoreCanPersist } from "../../../src/cron/store/row-codec.js";
import { saveCronStoreInDatabase } from "../../../src/cron/store/save.kernel.js";
import type { CronStoreFile } from "../../../src/cron/types.js";
import { deferSqlitePostCommitPublication } from "../../../src/infra/sqlite-post-commit.js";
import { runOpenClawStateWriteTransaction } from "../../../src/state/openclaw-state-db.js";

/** Synchronous fixture setup uses the production kernel without starting a scheduler worker. */
export function seedCronStoreInCurrentDatabase(storePath: string, store: CronStoreFile): void {
  assertCronStoreCanPersist(store);
  const storeKey = cronStoreKey(storePath);
  runOpenClawStateWriteTransaction((database) => {
    saveCronStoreInDatabase(database, storeKey, store);
    deferSqlitePostCommitPublication(database.db, () => noteCronJobsStoreCommit(storeKey));
  });
}
