import { deferSqlitePostCommitPublication } from "../../infra/sqlite-post-commit.js";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import type { CronStoreFile } from "../types.js";
import { serializeCronSaveError } from "./save-error.js";
import type { CronStoreSaveWorkerOperations } from "./save-worker.types.js";
import { saveCronStoreChangesInDatabase, saveCronStoreInDatabase } from "./save.kernel.js";

type SaveCommand = {
  [Key in keyof CronStoreSaveWorkerOperations]: {
    type: Key;
    input: CronStoreSaveWorkerOperations[Key]["input"];
  };
}[keyof CronStoreSaveWorkerOperations];

export function executeCronStoreSaveCommand(command: SaveCommand, database: OpenClawStateDatabase) {
  let committed = false;
  try {
    const result = runOpenClawStateWriteTransaction(
      ({ db }) => {
        let value: CronStoreFile | undefined;
        if (command.type === "cron.saveChanges") {
          value = saveCronStoreChangesInDatabase(
            db,
            command.input.storeKey,
            command.input.storeKey,
            command.input.changes,
            command.input.options,
          );
        } else {
          saveCronStoreInDatabase(
            database,
            command.input.storeKey,
            command.input.store,
            command.input.options,
          );
        }
        deferSqlitePostCommitPublication(db, () => {
          committed = true;
        });
        return value;
      },
      { database, env: getSqliteWorkerStateContext().environment },
      command.type === "cron.saveChanges" ? { operationLabel: "cron.config-mutation" } : undefined,
    );
    return { ok: true as const, value: result, committed };
  } catch (error) {
    return {
      ok: false as const,
      error: serializeCronSaveError(error, command.input.storeKey),
      committed,
    };
  }
}
