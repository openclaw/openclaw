import { isDeepStrictEqual } from "node:util";
import { assertCronJobsStoreUnchanged, CronJobsStoreChangedError } from "../../../cron/store.js";
import { resolveCronStoreKeyInDatabase } from "../../../cron/store/paths.js";
import type { EngineConnection } from "../../../infra/sql-connection.js";
import { captureOpenClawStateReadContext } from "../../../state/openclaw-state-worker-context.js";
import { inspectCronOwnerRowsForDoctor } from "./store-inventory.js";

/** Backup and commit must validate the same inspected rows under the captured source owner. */
export function captureLegacyCronRepairAdmission(state: {
  storePath: string;
  ownerRows: ReturnType<typeof inspectCronOwnerRowsForDoctor>;
  jobsFingerprint: string | undefined;
  legacyImport?: { assertCurrent: () => void };
}) {
  const source = captureOpenClawStateReadContext();
  const assertCurrent = () => {
    source.admission.assertCurrent();
    source.maintenanceScope?.assertDatabaseAccess(source.admission.databasePath);
  };
  const assertRowsUnchanged = (db: EngineConnection): undefined => {
    assertCurrent();
    state.legacyImport?.assertCurrent();
    if (
      !isDeepStrictEqual(
        inspectCronOwnerRowsForDoctor(db, resolveCronStoreKeyInDatabase(db, state.storePath)),
        state.ownerRows,
      )
    ) {
      throw new CronJobsStoreChangedError(state.storePath);
    }
    if (state.jobsFingerprint !== undefined) {
      assertCronJobsStoreUnchanged(db, state.storePath, state.jobsFingerprint);
    }
  };
  return { assertCurrent, assertRowsUnchanged };
}
