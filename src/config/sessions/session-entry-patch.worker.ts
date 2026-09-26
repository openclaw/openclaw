import { deferSqliteWorkerCommitReceipt } from "../../infra/sqlite-worker-operation-admission.js";
import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import type { SessionEntryReplacementPublication } from "./session-accessor.sqlite-entry-cache-publication.js";
import {
  applySessionEntryPatchInDatabase,
  type SessionEntryPatchCommit,
} from "./session-accessor.sqlite-entry-mutation.js";
import { prepareSessionEntryReplacementPublication } from "./session-accessor.sqlite-replacement-state.js";
import type { SessionEntry } from "./types.js";

export function applySessionEntryPatchInWorker(
  database: OpenClawAgentDatabase,
  options: OpenClawAgentDatabaseOptions,
  input: SessionEntryPatchCommit,
  admit: (
    stage: "transaction" | "commit",
    publication?: SessionEntryReplacementPublication,
    patchEntry?: SessionEntry,
  ) => void,
) {
  return runOpenClawAgentWriteTransaction(
    (current) => {
      if (current.db !== database.db) {
        throw new Error("Session patch lost its canonical database owner");
      }
      admit("transaction");
      const result = applySessionEntryPatchInDatabase(current, input, () => admit("transaction"));
      const publication = result.identity
        ? prepareSessionEntryReplacementPublication({
            ...result.identity,
            pendingArchiveRecovery: false,
            maintenancePlans: [],
            membershipInvalidatedKeys: [],
          })
        : undefined;
      if (publication) {
        deferSqliteWorkerCommitReceipt(current.db, publication);
      }
      admit("commit", publication, result.entry);
      return { entry: result.entry, publication };
    },
    options,
    { operationLabel: input.operationLabel },
  );
}
