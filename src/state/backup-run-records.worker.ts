import {
  recordBackupRunInDatabase,
  type PreparedBackupRunRecord,
} from "./backup-run-records.kernel.js";
import { assertOpenClawStateDatabaseOwner } from "./openclaw-state-db-maintenance.js";
import { withExistingOpenClawStateDatabaseArtifactPreservingReadOnly } from "./openclaw-state-db-readonly.js";
import { isOpenClawStateDatabaseOpen } from "./openclaw-state-db.js";
import type { WorkerWriteOperationContext } from "./worker-operation-registry.js";

export const backupRunOperations = {
  "backup.recordOutcome": (
    input: PreparedBackupRunRecord,
    context: WorkerWriteOperationContext,
  ) => {
    const options = context.stateOptions();
    // A best-effort ledger must not initialize or change a refused backup source.
    // An already-admitted writer carries ownership; cold admission stays read-only.
    if (!isOpenClawStateDatabaseOpen(options.path)) {
      const existing = withExistingOpenClawStateDatabaseArtifactPreservingReadOnly(({ db }) => {
        assertOpenClawStateDatabaseOwner(db, { pathname: options.path });
        return true;
      }, options);
      if (!existing) {
        return undefined;
      }
    }
    return context.write(({ db }) => recordBackupRunInDatabase(db, input));
  },
};
