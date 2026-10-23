import {
  runSqliteDeferredTransactionSync,
  runSqliteReadSnapshotSync,
} from "../../infra/sqlite-transaction.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  readDiskEvictableArchivedSessionBatchInDatabase,
  readHistoricalSessionIdsInDatabase,
} from "./session-history-eviction-candidates.js";
import type {
  ArchivedInput,
  HistoricalInput,
  HistoricalValue,
  LiveInput,
  LiveValue,
} from "./session-history-eviction-worker.types.js";
import { planLiveEvictionInDatabase } from "./session-live-eviction-plan.worker.js";

/** Disk-budget eviction discovery reads served by the session transcript worker. */
export function readSessionHistoryEvictionRequest(
  request: HistoricalInput | ArchivedInput | LiveInput,
): HistoricalValue | LiveValue {
  const options = { ...request.database, env: request.env };
  if (request.kind === "live-eviction") {
    const result = withOpenClawAgentDatabaseReadOnly(
      (database) =>
        runSqliteDeferredTransactionSync(database.db, () =>
          planLiveEvictionInDatabase(database, request.plan),
        ),
      options,
    );
    if (!result.found) {
      throw new Error(`SQLite live eviction cannot read its database: ${result.reason}`);
    }
    return { kind: "live-eviction", live: result.value };
  }
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      runSqliteReadSnapshotSync(database.db, () =>
        "archived" in request
          ? { batch: readDiskEvictableArchivedSessionBatchInDatabase(database, request.archived) }
          : { sessionIds: readHistoricalSessionIdsInDatabase({ ...request, database }) },
      ),
    options,
  );
  if (!result.found) {
    if ("archived" in request && result.reason === "database-missing") {
      return {
        kind: "historical-eviction-candidates",
        batch: { candidates: [], exhausted: true },
      };
    }
    throw new Error(`SQLite history eviction cannot read its database: ${result.reason}`);
  }
  return { kind: "historical-eviction-candidates", ...result.value };
}
