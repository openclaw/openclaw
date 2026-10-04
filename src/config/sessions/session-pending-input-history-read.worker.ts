import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { assertCapturedSessionEntryReadSource } from "./session-accessor.sqlite-exact-read.js";
import { readPendingInputHistoryInDatabase } from "./session-pending-input-history.kernel.js";
import type {
  PendingInputHistoryWorkerInput,
  PendingInputHistorySnapshot,
} from "./session-pending-input-history.types.js";

export function readPendingInputHistoryInWorker(
  request: PendingInputHistoryWorkerInput,
): PendingInputHistorySnapshot {
  const read = withOpenClawAgentDatabaseReadOnly(
    (database) => {
      assertCapturedSessionEntryReadSource(request.source, database);
      return readPendingInputHistoryInDatabase(database, request.query);
    },
    { ...request.database, env: request.env },
  );
  return read.found ? read.value : { rows: [], total: 0 };
}
