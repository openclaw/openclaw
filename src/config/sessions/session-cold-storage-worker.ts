import type { MessagePort } from "node:worker_threads";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import {
  sqliteSessionIdWriteScope,
  withSqliteDatabaseWriteScope,
} from "../../infra/sqlite-database-admission.js";
import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import type { SqliteWorkerExecutionAuthority } from "../../infra/sqlite-worker-contract.js";
import { assertDatabasePathIdentity } from "../../infra/sqlite-worker-identity.js";
import {
  retainOpenClawAgentDatabaseReadOnly,
  withOpenClawAgentDatabaseReadOnly,
} from "../../state/openclaw-agent-db-readonly.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { readSessionGoalOperationInDatabase } from "./goals-operation-receipts.js";
import type {
  SessionColdArchive,
  SessionColdExternalization,
  SessionColdPlan,
  SessionColdPrepared,
} from "./session-accessor.sqlite-archive-types.js";
import {
  readSessionStateDeleteSnapshot,
  sqliteSessionStateDeleteSnapshotsEqual,
} from "./session-accessor.sqlite-delete-snapshot.js";
import { resolveTranscriptAppendRefusal } from "./session-accessor.sqlite-transcript-write-guard.js";
import { readVerifiedSessionColdChunks } from "./session-cold-storage-chunks.js";
import {
  decodeSessionColdRecords,
  verifyPublishedSessionColdArchive,
} from "./session-cold-storage-codec.js";
import { readSessionColdStorageProtection } from "./session-cold-storage-eligibility.js";
import type { SessionColdRestorationGuard } from "./session-cold-storage-guard.types.js";
import { retainSessionColdNavigationInTransaction } from "./session-cold-storage-navigation.js";
import {
  writeSessionColdRecordsInTransaction,
  type SessionColdWriteRecord,
} from "./session-cold-storage-records.js";
import { readSessionAdmissionProtectionKeys } from "./session-cold-storage-selection.js";
import {
  readSessionColdLockedValidation,
  type prepareSessionColdSourceGuard,
  type SessionColdSourceMatches,
} from "./session-cold-storage-source-guard.worker.js";
import { readSessionColdTranscript } from "./session-cold-storage-state.js";
import type { SessionColdMutationResult, SessionColdSource } from "./session-cold-storage.types.js";
import type { SessionSourceValidation } from "./session-source-authority.js";
import { readSessionSourceValidation } from "./session-source-predicate.worker.js";
import {
  assertSessionStoreReadCandidate,
  isSessionStoreReadCandidateCurrent,
} from "./session-store-read-candidates.js";
import {
  publishUnchangedSessionTranscriptAuthority,
  readStagedSessionTranscriptAuthority,
} from "./session-transcript-authority.js";
import { deleteSessionTranscriptFtsRowsInTransaction } from "./session-transcript-fts.js";
import { sessionTranscriptIndexNeedsReconcile } from "./session-transcript-index.js";
import {
  createSessionTranscriptTurnKernel,
  sqliteSessionTranscriptTurnRebound,
} from "./session-turn.kernel.js";
import { resolveSessionWorkStartError } from "./session-work-start.js";
import { prepareTranscriptPayloadForReuse } from "./transcript-payload.js";

export type SessionColdMutationPlan = { databaseOptions: SessionColdPlan["databaseOptions"] } & (
  | { kind: "cold-maintain" }
  | { kind: "cold-sweep"; sessionId: string; afterSeq?: number; maxRows: number }
  | {
      kind: "cold-batch";
      prepared: SessionColdPrepared[];
      externalizations: SessionColdExternalization[];
      beforeMs: number;
      protectionKeys: string[];
      liveSessionKeys: string[];
    }
  | {
      kind: "cold-restore";
      sessionId: string;
      archive: Omit<SessionColdArchive, "archive_blob">;
      guard?: SessionColdRestorationGuard;
    }
);
export type SessionColdWorkerData = {
  source: SessionColdSource;
  executionAuthority?: SqliteWorkerExecutionAuthority;
  commitGate: SharedArrayBuffer;
  sourceMatches?: SessionColdSourceMatches;
  plan: SessionColdMutationPlan;
};

export type SqliteArchiveMutationRequest = {
  type: "cold-mutation";
  operationId: number;
  data: SessionColdWorkerData;
  port: MessagePort;
};

export function assertSessionColdSourceCurrent(pathname: string, source: SessionColdSource): void {
  for (const custody of source.readCustody ?? []) {
    assertSessionStoreReadCandidate(custody.sourcePath, custody.candidates);
    for (const candidate of custody.candidates) {
      if (!isSessionStoreReadCandidateCurrent(candidate)) {
        throw new Error("Cold transcript selection changed outside its original custody");
      }
      if (candidate.identity) {
        assertDatabasePathIdentity(candidate.path, candidate.identity);
      }
    }
  }
  assertDatabasePathIdentity(pathname, source.readIdentity);
}

export async function prepareSessionColdRestoreInWorker(
  plan: Extract<SessionColdMutationPlan, { kind: "cold-restore" }>,
): Promise<() => Generator<SessionColdWriteRecord>> {
  const opened = withOpenClawAgentDatabaseReadOnly(
    (database) => readSessionColdTranscript(database.db, plan.sessionId),
    plan.databaseOptions,
  );
  if (
    !opened.found ||
    !opened.value ||
    opened.value.archive_sha256 !== plan.archive.archive_sha256
  ) {
    throw new Error("Cold transcript changed before restoration");
  }
  const archive = opened.value;
  // Verify immutable files before any writes; each bounded unit decodes before admission.
  const verify = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      runSqliteReadSnapshotSync(
        database.db,
        () => {
          for (const chunk of readVerifiedSessionColdChunks(
            database.db,
            plan.databaseOptions.path,
            archive,
          )) {
            void chunk;
          }
        },
        { databaseLabel: database.path, operationLabel: "cold restore verification" },
      ),
    plan.databaseOptions,
  );
  if (!verify.found) {
    throw new Error("Cold transcript disappeared before restoration");
  }
  return function* () {
    const retained = retainOpenClawAgentDatabaseReadOnly(plan.databaseOptions);
    if (!retained.found) {
      throw new Error("Cold transcript disappeared before restoration");
    }
    try {
      const database = retained.database.db;
      // Current archives keep their complete identity and active projections. Legacy
      // archives, and interrupted legacy replays, still rebuild them from the archive.
      const retainedProjection =
        executeSqliteQueryTakeFirstSync(
          database,
          getNodeSqliteKysely<DB>(database)
            .selectFrom("session_transcript_index_state")
            .select("indexed_seq")
            .where("session_id", "=", plan.sessionId),
        )?.indexed_seq === archive.last_seq;
      for (const chunk of readVerifiedSessionColdChunks(
        database,
        plan.databaseOptions.path,
        archive,
      )) {
        const navigation = new Map(
          executeSqliteQuerySync(
            database,
            getNodeSqliteKysely<DB>(database)
              .selectFrom("transcript_events")
              .select(["seq", "navigation_json"])
              .where("session_id", "=", plan.sessionId)
              .where("seq", ">=", "first_seq" in chunk.archive ? chunk.archive.first_seq : 0)
              .where("seq", "<=", chunk.archive.last_seq)
              .where("navigation_json", "is not", null),
          ).rows.map((row) => [row.seq, row.navigation_json!]),
        );
        for (const record of decodeSessionColdRecords(chunk.bytes, chunk.archive)) {
          if (retainedProjection && record.kind !== "event" && record.kind !== "fts") {
            continue;
          }
          yield record.kind === "event"
            ? {
                ...record,
                preparedPayload: prepareTranscriptPayloadForReuse(
                  database,
                  record.row.event_json,
                  undefined,
                  navigation.get(record.row.seq),
                ),
              }
            : record;
        }
      }
    } finally {
      retained.claim.release();
    }
  };
}

/** Recheck the marker before each bounded unit so a restore cancels remaining cleanup. */
export function sweepSessionColdInTransaction(
  database: OpenClawAgentDatabase,
  input: { sessionId: string; afterSeq?: number; maxRows: number },
): { rows: number; afterSeq?: number } {
  if (readSessionColdTranscript(database.db, input.sessionId)?.storage !== "file") {
    return { rows: 0 };
  }
  return withSqliteDatabaseWriteScope(
    database.db,
    [sqliteSessionIdWriteScope(input.sessionId)],
    () => {
      if (input.afterSeq !== undefined) {
        return retainSessionColdNavigationInTransaction(
          database,
          input.sessionId,
          input.afterSeq,
          input.maxRows,
        );
      }
      const rows = deleteSessionTranscriptFtsRowsInTransaction(database.db, input.sessionId, {
        maxRows: input.maxRows,
      });
      if (rows > 0) {
        return { rows };
      }
      const db = getNodeSqliteKysely<DB>(database.db);
      const chunk = executeSqliteQueryTakeFirstSync(
        database.db,
        db
          .selectFrom("session_transcript_cold_archive_chunks")
          .select("chunk_index")
          .where("session_id", "=", input.sessionId)
          .where("archive_blob", "is not", null)
          .orderBy("chunk_index")
          .limit(1),
      );
      if (!chunk) {
        return { rows: 0 };
      }
      executeSqliteQuerySync(
        database.db,
        db
          .updateTable("session_transcript_cold_archive_chunks")
          .set({ archive_blob: null })
          .where("session_id", "=", input.sessionId)
          .where("chunk_index", "=", chunk.chunk_index),
      );
      return { rows: 1 };
    },
  );
}

export function mutateSessionColdTranscriptInWorker(
  plan: SessionColdMutationPlan,
  restore:
    | { phase: "clear" | "complete" }
    | { phase: "rows"; records: readonly SessionColdWriteRecord[] }
    | undefined,
  onCommit: (database: OpenClawAgentDatabase, validation?: SessionSourceValidation) => void,
  sourceGuard?: ReturnType<typeof prepareSessionColdSourceGuard>,
): SessionColdMutationResult {
  const startedAt = performance.now();
  const completed = runOpenClawAgentWriteTransaction(
    (database) => {
      const db = getNodeSqliteKysely<DB>(database.db);
      const result: SessionColdMutationResult = {
        archivedTranscripts: 0,
        externalizedTranscripts: 0,
        restored: false,
      };
      let sourceValidation: SessionSourceValidation | undefined;
      if (plan.kind === "cold-maintain") {
        onCommit(database);
        return result;
      }
      if (plan.kind === "cold-sweep") {
        result.sweep = {
          ...sweepSessionColdInTransaction(database, plan),
          elapsedMs: 0,
        };
        onCommit(database);
        return result;
      }
      if (plan.kind === "cold-batch") {
        const sessionIds = [
          ...plan.prepared.map((item) => item.plan.sessionId),
          ...plan.externalizations.map((item) => item.archive.session_id),
        ];
        const protectionKeys = readSessionAdmissionProtectionKeys(database, sessionIds);
        if ([...protectionKeys].some((key) => !plan.protectionKeys.includes(key))) {
          throw new Error("Transcript ownership changed; cold archival was canceled");
        }
        let protectedIds: Set<string> | undefined;
        for (const prepared of plan.prepared) {
          protectedIds ??= readSessionColdStorageProtection(
            database,
            plan.beforeMs,
            new Set(plan.liveSessionKeys),
            sessionIds,
          );
          const { sessionId, snapshot } = prepared.plan;
          const fresh = readSessionStateDeleteSnapshot(database.db, sessionId);
          if (
            readSessionColdTranscript(database.db, sessionId) ||
            sessionTranscriptIndexNeedsReconcile(database.db, sessionId) ||
            protectedIds.has(sessionId) ||
            !sqliteSessionStateDeleteSnapshotsEqual(fresh, snapshot) ||
            fresh.transcriptUpdatedAt === null ||
            fresh.transcriptUpdatedAt >= plan.beforeMs
          ) {
            continue;
          }
          for (const file of prepared.chunks.length ? prepared.chunks : [prepared.archive]) {
            verifyPublishedSessionColdArchive(plan.databaseOptions.path, file);
          }
          withSqliteDatabaseWriteScope(database.db, [sqliteSessionIdWriteScope(sessionId)], () => {
            executeSqliteQuerySync(
              database.db,
              db.insertInto("session_transcript_cold_archives").values(prepared.archive),
            );
            for (const chunk of prepared.chunks) {
              executeSqliteQuerySync(
                database.db,
                db
                  .insertInto("session_transcript_cold_archive_chunks")
                  .values({ ...chunk, archive_blob: null }),
              );
            }
          });
          if (fresh.sessionKey) {
            publishUnchangedSessionTranscriptAuthority(database, fresh.sessionKey);
          }
          result.archivedTranscripts++;
        }
        for (const { archive, chunks } of plan.externalizations) {
          const current = readSessionColdTranscript(database.db, archive.session_id);
          if (
            !current ||
            current.storage !== "sqlite" ||
            current.generation !== archive.generation ||
            current.archive_sha256 !== archive.archive_sha256 ||
            current.archive_name !== archive.archive_name
          ) {
            continue;
          }
          for (const file of chunks.length ? chunks : [archive]) {
            verifyPublishedSessionColdArchive(plan.databaseOptions.path, file);
          }
          withSqliteDatabaseWriteScope(
            database.db,
            [sqliteSessionIdWriteScope(archive.session_id)],
            () => {
              executeSqliteQuerySync(
                database.db,
                db
                  .updateTable("session_transcript_cold_archives")
                  .set({ storage: "file", archive_blob: null })
                  .where("session_id", "=", archive.session_id),
              );
            },
          );
          result.externalizedTranscripts++;
        }
      } else {
        if (plan.guard?.kind === "turn") {
          const { sessionKey, options, goalOperation } = plan.guard;
          const kernel = createSessionTranscriptTurnKernel(
            {
              agentId: plan.guard.agentId,
              path: database.path,
              sessionId: plan.sessionId,
              sessionKey,
            },
            { ...options, messages: [], sessionFile: "" },
          );
          const selected = kernel.readEntry(database);
          const entries = new Map([[sessionKey, selected?.entry]]);
          sourceValidation = sourceGuard
            ? sourceGuard.read(database, entries)
            : readSessionSourceValidation(database, plan.guard.sources, undefined, entries);
          const { refusedSource } = sourceValidation;
          if (refusedSource) {
            return { ...result, refusedSource };
          }
          if (
            (plan.guard.requireActive &&
              resolveSessionWorkStartError(sessionKey, selected?.entry)) ||
            (!kernel.resolveExpectedEntry(selected) &&
              !(
                selected?.entry.sessionId === options.expectedSessionId &&
                goalOperation &&
                readSessionGoalOperationInDatabase(database, {
                  sessionKey,
                  expectedSessionId: options.expectedSessionId,
                  operation: goalOperation,
                })
              ))
          ) {
            return { ...result, turnRebound: sqliteSessionTranscriptTurnRebound(selected, "") };
          }
        } else if (plan.guard?.kind === "locked") {
          const validation = readSessionColdLockedValidation(
            { database, sessionId: plan.sessionId, guard: plan.guard, sourceGuard },
            resolveTranscriptAppendRefusal,
          );
          sourceValidation = validation.sourceValidation;
          if (sourceValidation.refusedSource || validation.writerRefusal) {
            return {
              ...result,
              refusedSource: sourceValidation.refusedSource,
              writerRefusal: validation.writerRefusal,
            };
          }
        }
        const current = readSessionColdTranscript(database.db, plan.sessionId);
        if (!current) {
          return result;
        }
        if (
          current.generation !== plan.archive.generation ||
          current.archive_sha256 !== plan.archive.archive_sha256 ||
          !restore
        ) {
          throw new Error("Cold transcript changed during restoration");
        }
        const session_id = plan.sessionId;
        withSqliteDatabaseWriteScope(database.db, [sqliteSessionIdWriteScope(session_id)], () => {
          if (restore.phase === "clear") {
            result.restoreCleanupRows = deleteSessionTranscriptFtsRowsInTransaction(
              database.db,
              session_id,
              { maxRows: 256 },
            );
          } else if (restore.phase === "rows") {
            // Retained navigation stays complete while the cold marker owns all reads.
            writeSessionColdRecordsInTransaction(database, session_id, restore.records, "restore");
          } else {
            executeSqliteQuerySync(
              database.db,
              db
                .deleteFrom("session_transcript_cold_archives")
                .where("session_id", "=", session_id),
            );
            result.restored = true;
          }
        });
        if (!result.restored) {
          result.restorePending = true;
          // Provisional batches stay cold; the commit grant belongs to final publication.
          return result;
        }
        result.sessionKey = executeSqliteQueryTakeFirstSync(
          database.db,
          db
            .selectFrom("session_windows")
            .select("session_key")
            .where("session_id", "=", session_id),
        )?.session_key;
      }
      if (result.restored && result.sessionKey) {
        publishUnchangedSessionTranscriptAuthority(database, result.sessionKey);
      }
      result.transcriptPublication = readStagedSessionTranscriptAuthority(database);
      onCommit(database, sourceValidation);
      sourceGuard?.assertForeign();
      return result;
    },
    plan.databaseOptions,
    { operationLabel: `session.cold.${plan.kind.slice("cold-".length)}` },
  );
  if (completed.sweep) {
    completed.sweep.elapsedMs = performance.now() - startedAt;
  }
  return completed;
}
