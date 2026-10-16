import { readAcpSessionControlInWorker } from "../acp/runtime/session-meta-source.worker.js";
import {
  requestSessionEntriesCurrentAdmission,
  requestSessionEntryCurrentAdmission,
} from "../config/sessions/session-entry-current-admission.worker.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import { normalizeSqliteNumber } from "../infra/sqlite-number.js";
import { requestSqliteWorkerOperationAdmission } from "../infra/sqlite-worker-operation-admission.js";
import type { OpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { SESSION_WATCH_PROVENANCE_EXPLICIT } from "../state/session-watch-cursor-provenance.js";
import type {
  WorkerOperationHandlers,
  WorkerWriteOperationContext,
} from "../state/worker-operation-registry.js";
import {
  getSessionStateKysely,
  hasSessionStateWatchersInDatabase,
  isAmbientGroupWatchCursor,
  isSessionStateUpstreamCurrentInDatabase,
  pruneSessionStateEventsInDatabase,
  readCursor,
  recordSessionStateEventInDatabase,
  upsertSeedCursor,
  type SessionStateEventInput,
  type SessionStateEventRow,
  type SessionStateNotice,
} from "./session-state-events.kernel.js";
import { readSessionStateSequence } from "./session-state-events.read.worker.js";
import {
  isSessionStateWatchAddress,
  sessionStateWatchAgentId,
} from "./session-state-events.watch-address.js";
import type { SessionStateWorkerOperations } from "./session-state-events.worker-contract.js";
import { deleteSessionUpstreamLinkInDatabase } from "./session-upstream-links.kernel.js";

export const sessionStateOperations = {
  "sessionState.cleanup": (
    input: SessionStateWorkerOperations["sessionState.cleanup"]["input"],
    context,
  ) => {
    return context.write(({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
      const kysely = getSessionStateKysely(db);
      if (input.kind === "delete") {
        deleteSessionUpstreamLinkInDatabase(db, input.sessionKey, input.agentId);
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
      const cursorOwner = sessionStateWatchAgentId(input.sessionKey);
      const cursors =
        cursorOwner && (input.kind === "reset" || cursorOwner === input.agentId)
          ? executeSqliteQuerySync(
              db,
              kysely
                .selectFrom("session_watch_cursors")
                .select(["watcher_session_key", "target_session_key"])
                .where((eb) =>
                  input.kind === "reset"
                    ? eb("watcher_session_key", "=", input.sessionKey)
                    : eb.or([
                        eb("watcher_session_key", "=", input.sessionKey),
                        eb("target_session_key", "=", input.sessionKey),
                      ]),
                ),
            ).rows
          : [];
      for (const cursor of cursors) {
        if (
          !isSessionStateWatchAddress({
            watcherSessionKey: cursor.watcher_session_key,
            targetSessionKey: cursor.target_session_key,
          })
        ) {
          continue;
        }
        executeSqliteQuerySync(
          db,
          kysely
            .deleteFrom("session_watch_cursors")
            .where("watcher_session_key", "=", cursor.watcher_session_key)
            .where("target_session_key", "=", cursor.target_session_key),
        );
      }
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
    });
  },
  "sessionState.sweep": (
    { cursors, now }: SessionStateWorkerOperations["sessionState.sweep"]["input"],
    context,
  ) => {
    return context.write(({ db }) => {
      requestSqliteWorkerOperationAdmission({ stage: "transaction", facts: undefined });
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
      requestSqliteWorkerOperationAdmission({ stage: "commit", facts: undefined });
      return notices;
    });
  },
  "sessionState.registerWatch": (
    input: SessionStateWorkerOperations["sessionState.registerWatch"]["input"],
    context,
  ) => {
    const database = context.open();
    if (!isSessionStateWatchAddress(input)) {
      return false;
    }
    const admit = (stage: "prepare" | "transaction" | "commit") =>
      requestSessionEntriesCurrentAdmission(input.sessionEntryCurrentSources, {
        stage,
        facts: undefined,
      });
    const current = readCursor(database.db, input.watcherSessionKey, input.targetSessionKey);
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
    return context.write(({ db }) => {
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
    });
  },
  "sessionState.acknowledge": (
    input: SessionStateWorkerOperations["sessionState.acknowledge"]["input"],
    context,
  ) => {
    const { watcherSessionKey, cursors, now } = input;
    const admit = (stage: "transaction" | "commit") =>
      requestSessionEntriesCurrentAdmission(input.sessionEntryCurrentSources, {
        stage,
        facts: undefined,
      });
    return context.write(({ db }) => {
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
    });
  },
  "sessionState.prune": (
    input: SessionStateWorkerOperations["sessionState.prune"]["input"],
    context,
  ) => {
    const admit = (stage: "transaction" | "commit") =>
      requestSessionEntryCurrentAdmission(input.sessionEntryCurrentSource, {
        stage,
        facts: undefined,
      });
    return context.write(({ db }) => {
      admit("transaction");
      pruneSessionStateEventsInDatabase(db, input.now);
      admit("commit");
    });
  },
  "sessionState.record": (
    input: SessionStateWorkerOperations["sessionState.record"]["input"],
    context,
  ) => {
    const database = context.open();
    const admit = (stage: "transaction" | "commit") =>
      requestSessionEntryCurrentAdmission(input.sessionEntryCurrentSource, {
        stage,
        facts: undefined,
      });
    const { events, now, onlyIfWatched, expectedUpstream, acpControl } = input;
    const assertAcpControl = () => {
      if (acpControl && !readAcpSessionControlInWorker(database, acpControl).row) {
        throw new Error("ACP task owner could not be verified.");
      }
    };
    const current = (db: OpenClawStateDatabase["db"], event: SessionStateEventInput) =>
      (!onlyIfWatched || hasSessionStateWatchersInDatabase(db, event.sessionKey)) &&
      (!expectedUpstream || isSessionStateUpstreamCurrentInDatabase(db, expectedUpstream));
    // Unwatched human turns stay write-free; queued writes repeat the check under the lock.
    if (!events.some((event) => current(database.db, event))) {
      return { rows: [], notices: [] };
    }
    return context.write(({ db }) => {
      admit("transaction");
      assertAcpControl();
      const rows: SessionStateEventRow[] = [];
      const notices: SessionStateNotice[] = [];
      for (const event of events) {
        if (!current(db, event)) {
          continue;
        }
        const recorded = recordSessionStateEventInDatabase(db, event, now);
        if (recorded.row) {
          rows.push(recorded.row);
        }
        notices.push(...recorded.notices);
      }
      admit("commit");
      assertAcpControl();
      return { rows, notices };
    });
  },
} satisfies WorkerOperationHandlers<WorkerWriteOperationContext>;
