import { readAcpSessionControlInWorker } from "../acp/runtime/session-meta-source.worker.js";
import {
  requestSessionEntriesCurrentAdmission,
  requestSessionEntryCurrentAdmission,
} from "../config/sessions/session-entry-current-admission.worker.js";
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
  if (command.type === "sessionState.cleanup") {
    const input = command.input;
    return runOpenClawStateWriteTransaction(({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      const kysely = getSessionStateKysely(db);
      if (input.kind === "delete") {
        for (const table of ["session_state_events", "session_state_heads"] as const) {
          executeSqliteQuerySync(
            db,
            kysely
              .deleteFrom(table)
              .where("session_key", "=", input.sessionKey)
              .where("agent_id", "=", input.agentId),
          );
        }
      }
      executeSqliteQuerySync(
        db,
        kysely
          .deleteFrom("session_watch_cursors")
          .where((eb) =>
            input.kind === "reset"
              ? eb("watcher_session_key", "=", input.sessionKey)
              : eb.or([
                  eb("watcher_session_key", "=", input.sessionKey),
                  eb("target_session_key", "=", input.sessionKey),
                ]),
          ),
      );
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
    }, options);
  }
  if (command.type === "sessionState.sweep") {
    const { cursors, now, sessionEntryCurrentSources } = command.input;
    const admit = (stage: "transaction" | "commit") =>
      requestSessionEntriesCurrentAdmission(sessionEntryCurrentSources, {
        stage,
        facts: undefined,
      });
    return runOpenClawStateWriteTransaction(({ db }) => {
      admit("transaction");
      const notices: SessionStateNotice[] = [];
      for (const { watcherSessionKey, targetSessionKey, watcherStorePath } of cursors) {
        const row = readCursor(db, watcherSessionKey, targetSessionKey);
        if (!row || (row.watcher_store_path ?? null) !== watcherStorePath) {
          continue;
        }
        const material = normalizeSqliteNumber(row.material_sequence) ?? 0;
        const lastSeen = normalizeSqliteNumber(row.last_seen_sequence) ?? 0;
        if (material <= lastSeen) {
          continue;
        }
        executeSqliteQuerySync(
          db,
          getSessionStateKysely(db)
            .updateTable("session_watch_cursors")
            .set({ notified_sequence: material, updated_at: now })
            .where("watcher_session_key", "=", watcherSessionKey)
            .where("target_session_key", "=", targetSessionKey),
        );
        notices.push({
          watcherSessionKey,
          watcherStorePath,
          targetSessionKey,
          lastSeenSequence: lastSeen,
          queueOnly: isAmbientGroupWatchCursor(row),
        });
      }
      admit("commit");
      return notices;
    }, options);
  }
  if (command.type === "sessionState.registerWatch") {
    const input = command.input;
    const admit = (stage: "prepare" | "transaction" | "commit") =>
      requestSessionEntriesCurrentAdmission(input.sessionEntryCurrentSources, {
        stage,
        facts: undefined,
      });
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
      if (input.sessionEntryCurrentSources?.length) {
        admit("prepare");
      }
      return true;
    }
    return runOpenClawStateWriteTransaction(({ db }) => {
      admit("transaction");
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
      admit("commit");
      return true;
    }, options);
  }
  if (command.type === "sessionState.acknowledge") {
    const { watcherSessionKey, cursors, now } = command.input;
    const admit = (stage: "transaction" | "commit") =>
      requestSessionEntriesCurrentAdmission(command.input.sessionEntryCurrentSources, {
        stage,
        facts: undefined,
      });
    return runOpenClawStateWriteTransaction(({ db }) => {
      admit("transaction");
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
      admit("commit");
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
