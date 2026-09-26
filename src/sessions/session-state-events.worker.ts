import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  hasSessionStateWatchersInDatabase,
  isSessionStateUpstreamCurrentInDatabase,
  pruneSessionStateEventsInDatabase,
  recordSessionStateEventInDatabase,
  type SessionStateEventInput,
  type SessionStateEventRow,
  type SessionStateNotice,
} from "./session-state-events.kernel.js";
import type { SessionUpstreamLink } from "./session-upstream-links.kernel.js";

export type SessionStateWorkerOperations = {
  "sessionState.record": {
    input: {
      event: SessionStateEventInput;
      now: number;
      onlyIfWatched?: boolean;
      expectedUpstream?: SessionUpstreamLink;
    };
    output: { row?: SessionStateEventRow; notices: SessionStateNotice[] };
  };
  "sessionState.prune": { input: { now: number }; output: void };
};

export function executeSessionStateCommand(
  command: SqliteWorkerCommand<SessionStateWorkerOperations>,
  options: OpenClawStateDatabaseOptions & { database: OpenClawStateDatabase },
): SessionStateWorkerOperations[keyof SessionStateWorkerOperations]["output"] {
  if (command.type === "sessionState.prune") {
    return runOpenClawStateWriteTransaction(({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      pruneSessionStateEventsInDatabase(db, command.input.now);
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
    }, options);
  }
  const { event, now, onlyIfWatched, expectedUpstream } = command.input;
  const current = (db: OpenClawStateDatabase["db"]) =>
    (!onlyIfWatched || hasSessionStateWatchersInDatabase(db, event.sessionKey)) &&
    (!expectedUpstream || isSessionStateUpstreamCurrentInDatabase(db, expectedUpstream));
  // Unwatched human turns stay write-free; queued writes repeat the check under the lock.
  if (!current(options.database.db)) {
    return { notices: [] };
  }
  return runOpenClawStateWriteTransaction(({ db }) => {
    requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
    if (!current(db)) {
      return { notices: [] };
    }
    const recorded = recordSessionStateEventInDatabase(db, event, now);
    requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
    return recorded;
  }, options);
}
