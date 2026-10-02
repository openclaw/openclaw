import { readAcpSessionControlInWorker } from "../acp/runtime/session-meta-source.worker.js";
import { requestSessionEntryCurrentAdmission } from "../config/sessions/session-entry-current-admission.worker.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import {
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { SESSION_WATCH_PROVENANCE_EXPLICIT } from "../state/session-watch-cursor-provenance.js";
import {
  getSessionStateKysely,
  hasSessionStateWatchersInDatabase,
  isAmbientGroupWatchCursor,
  isSessionStateUpstreamCurrentInDatabase,
  pruneSessionStateEventsInDatabase,
  readCursor,
  recordSessionStateEventInDatabase,
  upsertSeedCursor,
  type SessionStateNotice,
} from "./session-state-events.kernel.js";
import { readSessionStateSequence } from "./session-state-events.read.worker.js";
import type { SessionStateWorkerOperations } from "./session-state-events.worker-contract.js";

export function executeSessionStateCommand(
  command: SqliteWorkerCommand<SessionStateWorkerOperations>,
  options: OpenClawStateDatabaseOptions & { database: OpenClawStateDatabase },
): SessionStateWorkerOperations[keyof SessionStateWorkerOperations]["output"] {
  if (command.type === "sessionState.registerWatch") {
    const input = command.input;
    const current = readCursor(
      options.database.db,
      input.watcherSessionKey,
      input.targetSessionKey,
    );
    // Every human group turn reaches registration; an unchanged watch stays write-free.
    if (
      current?.watcher_store_path === input.watcherStorePath &&
      (input.provenance !== SESSION_WATCH_PROVENANCE_EXPLICIT ||
        current.provenance === input.provenance)
    ) {
      return true;
    }
    return runOpenClawStateWriteTransaction(({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      const existing = readCursor(db, input.watcherSessionKey, input.targetSessionKey);
      if (existing?.watcher_store_path === input.watcherStorePath) {
        if (
          input.provenance === SESSION_WATCH_PROVENANCE_EXPLICIT &&
          existing.provenance !== input.provenance
        ) {
          executeSqliteQuerySync(
            db,
            getSessionStateKysely(db)
              .updateTable("session_watch_cursors")
              .set({ provenance: input.provenance })
              .where("watcher_session_key", "=", input.watcherSessionKey)
              .where("target_session_key", "=", input.targetSessionKey),
          );
        }
      } else {
        upsertSeedCursor({
          db,
          ...input,
          sequence: readSessionStateSequence(db, input.targetSessionKey, input.targetAgentId),
        });
      }
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      return true;
    }, options);
  }
  if (command.type === "sessionState.acknowledge") {
    const { watcherSessionKey, cursors, now } = command.input;
    return runOpenClawStateWriteTransaction(({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      const followups: SessionStateNotice[] = [];
      for (const { targetSessionKey, watcherStorePath } of cursors) {
        const row = readCursor(db, watcherSessionKey, targetSessionKey);
        if (!row || row.watcher_store_path !== watcherStorePath) {
          continue;
        }
        const notified = normalizeSqliteNumber(row.notified_sequence) ?? 0;
        const material = normalizeSqliteNumber(row.material_sequence) ?? 0;
        executeSqliteQuerySync(
          db,
          getSessionStateKysely(db)
            .updateTable("session_watch_cursors")
            .set({
              last_seen_sequence: notified,
              notified_sequence: Math.max(material, notified),
              updated_at: now,
            })
            .where("watcher_session_key", "=", watcherSessionKey)
            .where("target_session_key", "=", targetSessionKey),
        );
        if (material > notified) {
          followups.push({
            watcherSessionKey,
            watcherStorePath,
            targetSessionKey,
            lastSeenSequence: notified,
            queueOnly: isAmbientGroupWatchCursor(row),
          });
        }
      }
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      return followups;
    }, options);
  }
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
