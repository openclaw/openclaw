import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import type { OpenClawAgentReadOnlyDatabase } from "../../state/openclaw-agent-db-readonly.js";
import { readSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import { readTranscriptIdentityByEventId } from "./session-accessor.sqlite-read.js";
import {
  loadTranscriptSuffixEventsBoundedFromDatabase,
  readPreviousIndexedTranscriptEventSync,
} from "./session-accessor.sqlite-suffix-read.js";
import { resolveTranscriptMessageAppendParent } from "./session-accessor.sqlite-transcript-parent.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import type { SessionTranscriptRuntimeTarget } from "./session-accessor.types.js";
import { readWithCanonicalSessionAdmission } from "./session-canonical-key.js";
import type {
  SessionTranscriptMaintenanceRead,
  SessionTranscriptMaintenanceFacts,
} from "./session-transcript-hydration.types.js";

export function readSessionTranscriptMaintenance(
  database: OpenClawAgentReadOnlyDatabase,
  target: SessionTranscriptRuntimeTarget,
  request: SessionTranscriptMaintenanceRead,
): SessionTranscriptMaintenanceFacts {
  if (request.operation === "previous") {
    return {
      kind: "transcript-maintenance",
      previous: readPreviousIndexedTranscriptEventSync(target, request.beforeSeq, {
        readOnly: true,
      })?.event,
    };
  }
  if (request.operation === "suffix") {
    return {
      kind: "transcript-maintenance",
      events: loadTranscriptSuffixEventsBoundedFromDatabase(
        database,
        target,
        request.startSeq,
        request,
      ),
    };
  }
  return readWithCanonicalSessionAdmission(database, () =>
    runSqliteDeferredTransactionSync(
      database.db,
      (): SessionTranscriptMaintenanceFacts =>
        request.operation === "identity"
          ? {
              kind: "transcript-maintenance",
              seq: readTranscriptIdentityByEventId(database, target.sessionId, request.eventId)
                ?.seq,
            }
          : {
              kind: "transcript-maintenance",
              version: readTranscriptContextVersionInTransaction(database, target.sessionId),
              lifecycleRevision: readSessionEntryRow(database, target.sessionKey)?.entry
                .lifecycleRevision,
              appendParentId: resolveTranscriptMessageAppendParent(database, target.sessionId, {}),
            },
      { databaseLabel: database.path, operationLabel: "session transcript maintenance read" },
    ),
  );
}
