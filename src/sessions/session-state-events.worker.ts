import { readAcpSessionControlInWorker } from "../acp/runtime/session-meta-source.worker.js";
import { requestSessionEntryCurrentAdmission } from "../config/sessions/session-entry-current-admission.worker.js";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
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
} from "./session-state-events.kernel.js";
import type { SessionStateWorkerOperations } from "./session-state-events.worker-contract.js";

export function executeSessionStateCommand(
  command: SqliteWorkerCommand<SessionStateWorkerOperations>,
  options: OpenClawStateDatabaseOptions & { database: OpenClawStateDatabase },
): SessionStateWorkerOperations[keyof SessionStateWorkerOperations]["output"] {
  const admit = (stage: "transaction" | "commit") =>
    requestSessionEntryCurrentAdmission(command.input.sessionEntryCurrentSource, {
      stage,
      facts: undefined,
    });
  if (command.type === "sessionState.prune") {
    return runOpenClawStateWriteTransaction(({ db }) => {
      admit("transaction");
      pruneSessionStateEventsInDatabase(db, command.input.now);
      admit("commit");
    }, options);
  }
  const { event, now, onlyIfWatched, expectedUpstream, acpControl } = command.input;
  const assertAcpControl = () => {
    if (acpControl && !readAcpSessionControlInWorker(options.database, acpControl).row) {
      throw new Error("ACP task owner could not be verified.");
    }
  };
  const current = (db: OpenClawStateDatabase["db"]) =>
    (!onlyIfWatched || hasSessionStateWatchersInDatabase(db, event.sessionKey)) &&
    (!expectedUpstream || isSessionStateUpstreamCurrentInDatabase(db, expectedUpstream));
  // Unwatched human turns stay write-free; queued writes repeat the check under the lock.
  if (!current(options.database.db)) {
    return { notices: [] };
  }
  return runOpenClawStateWriteTransaction(({ db }) => {
    admit("transaction");
    assertAcpControl();
    if (!current(db)) {
      return { notices: [] };
    }
    const recorded = recordSessionStateEventInDatabase(db, event, now);
    admit("commit");
    assertAcpControl();
    return recorded;
  }, options);
}
