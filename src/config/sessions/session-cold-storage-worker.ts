import path from "node:path";
import type { MessagePort } from "node:worker_threads";
import zlib from "node:zlib";
import { requireDirectorySync, syncDirectorySync } from "../../infra/directory-durability.js";
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
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { readSessionGoalOperationInDatabase } from "./goals-operations.js";
import { publishEncodedSessionTranscriptArchive } from "./session-accessor.sqlite-archive-artifact.js";
import type {
  SessionColdArchive,
  SessionColdBatchInput,
  SessionColdBatchPrepared,
  SessionColdExternalization,
  SessionColdPlan,
  SessionColdPrepared,
} from "./session-accessor.sqlite-archive-types.js";
import {
  readSessionStateDeleteSnapshot,
  sqliteSessionStateDeleteSnapshotsEqual,
} from "./session-accessor.sqlite-delete-snapshot.js";
import { resolveTranscriptAppendRefusal } from "./session-accessor.sqlite-transcript-write-guard.js";
import { iterateSessionColdRecords, readSessionColdChunks } from "./session-cold-storage-chunks.js";
import {
  decodeSessionColdRecords,
  MAX_COLD_ARCHIVE_BYTES,
  readVerifiedSessionColdArchive,
  resolveSessionColdArchivePath,
  verifyPublishedSessionColdArchive,
  type SessionColdRecord,
} from "./session-cold-storage-codec.js";
import { readSessionColdStorageProtection } from "./session-cold-storage-eligibility.js";
import type { SessionColdRestorationGuard } from "./session-cold-storage-guard.types.js";
import {
  ColdArchiveBudgetError,
  ColdArchiveLimitError,
  prepareSessionColdArchiveInWorker,
} from "./session-cold-storage-prepare.js";
import {
  readSessionAdmissionProtectionKeys,
  selectSessionColdBatch,
} from "./session-cold-storage-selection.js";
import {
  readSessionColdLockedValidation,
  type prepareSessionColdSourceGuard,
  type SessionColdSourceMatches,
} from "./session-cold-storage-source-guard.worker.js";
import { readSessionColdTranscript } from "./session-cold-storage-state.js";
import type { SessionColdMutationResult } from "./session-cold-storage.types.js";
import type { SessionSourceValidation } from "./session-source-authority.js";
import { readSessionSourceValidation } from "./session-source-predicate.worker.js";
import {
  publishUnchangedSessionTranscriptAuthority,
  readStagedSessionTranscriptAuthority,
} from "./session-transcript-authority.js";
import {
  createSessionTranscriptFtsInserter,
  deleteSessionTranscriptFtsRowsInTransaction,
} from "./session-transcript-fts.js";
import {
  createSessionTranscriptTurnKernel,
  sqliteSessionTranscriptTurnRebound,
} from "./session-turn.kernel.js";
import { resolveSessionWorkStartError } from "./session-work-start.js";
import { prepareTranscriptPayload, TRANSCRIPT_INSERT_BATCH_SIZE } from "./transcript-payload.js";

export type SessionColdMutationPlan = { databaseOptions: SessionColdPlan["databaseOptions"] } & (
  | { kind: "cold-maintain" }
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

async function prepareExternalization(
  input: SessionColdBatchInput,
  expected: Omit<SessionColdArchive, "archive_blob">,
  maxEnvelopeBytes: number,
): Promise<SessionColdExternalization | undefined> {
  const opened = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      executeSqliteQuerySync(
        database.db,
        getNodeSqliteKysely<DB>(database.db)
          .selectFrom("session_transcript_cold_archives")
          .selectAll()
          .where("session_id", "=", expected.session_id),
      ).rows[0],
    input.databaseOptions,
  );
  const archive = opened.found ? opened.value : undefined;
  if (
    !archive ||
    archive.storage !== "sqlite" ||
    archive.generation !== expected.generation ||
    archive.archive_sha256 !== expected.archive_sha256
  ) {
    return undefined;
  }
  const selected = withOpenClawAgentDatabaseReadOnly(
    (database) => readSessionColdChunks(database.db, archive),
    input.databaseOptions,
  );
  if (!selected.found) {
    throw new Error("Cold transcript disappeared before externalization");
  }
  const chunks = selected.value;
  let envelopeBytes = 0;
  for (const file of chunks.length ? chunks : [archive]) {
    const embedded = chunks.length
      ? withOpenClawAgentDatabaseReadOnly(
          (database) =>
            executeSqliteQueryTakeFirstSync(
              database.db,
              getNodeSqliteKysely<DB>(database.db)
                .selectFrom("session_transcript_cold_archive_chunks")
                .select("archive_blob")
                .where("session_id", "=", archive.session_id)
                .where("archive_name", "=", file.archive_name),
            )?.archive_blob,
          input.databaseOptions,
        )
      : undefined;
    const bytes = await readVerifiedSessionColdArchive({
      storePath: input.databaseOptions.path,
      archive: {
        ...file,
        storage: "sqlite",
        archive_blob: embedded?.found ? (embedded.value ?? null) : archive.archive_blob,
      },
    });
    // A window is indivisible; its files are bounded independently of the remaining pass budget.
    envelopeBytes += zlib.zstdDecompressSync(bytes, {
      maxOutputLength: MAX_COLD_ARCHIVE_BYTES,
    }).byteLength;
    if (envelopeBytes > maxEnvelopeBytes) {
      throw new ColdArchiveBudgetError();
    }
    decodeSessionColdRecords(bytes, { ...file, generation: archive.generation });
    const directory = path.dirname(
      resolveSessionColdArchivePath(input.databaseOptions.path, file.archive_name),
    );
    publishEncodedSessionTranscriptArchive({
      archiveDirectory: directory,
      archiveName: file.archive_name,
      bytes,
      sha256: file.archive_sha256,
    });
    requireDirectorySync(syncDirectorySync(directory), "Cold archive directory");
    requireDirectorySync(syncDirectorySync(path.dirname(directory)), "Session artifact directory");
  }
  return { archive: expected, chunks, envelopeBytes };
}

export async function prepareSessionColdBatchInWorker(
  input: SessionColdBatchInput,
): Promise<SessionColdBatchPrepared> {
  const result: SessionColdBatchPrepared = {
    freePages: 0,
    protectionKeys: [],
    prepared: [],
    externalizations: [],
    oversizedTranscripts: [],
    envelopeBytes: 0,
  };
  const selection = selectSessionColdBatch(input);
  if (!selection.found) {
    return result;
  }
  result.freePages = selection.value.freePages;
  result.oversizedTranscripts = selection.value.oversizedTranscripts;
  const maxBytes = Math.min(input.maxBytes, MAX_COLD_ARCHIVE_BYTES);
  const candidates = [
    ...selection.value.externalizations.map((archive) => ({
      kind: "externalize" as const,
      archive,
    })),
    ...selection.value.plans.map((plan) => ({ kind: "archive" as const, plan })),
  ];
  for (const candidate of candidates.slice(0, 128)) {
    const remaining = maxBytes - result.envelopeBytes;
    if (remaining <= 0) {
      break;
    }
    // Only a first window with the full pass budget may exceed it atomically.
    const budget =
      result.envelopeBytes === 0 && maxBytes === MAX_COLD_ARCHIVE_BYTES ? Infinity : remaining;
    try {
      if (candidate.kind === "archive") {
        const prepared = prepareSessionColdArchiveInWorker(candidate.plan, budget);
        result.prepared.push(prepared);
        result.envelopeBytes += prepared.envelopeBytes;
      } else {
        const prepared = await prepareExternalization(input, candidate.archive, budget);
        if (prepared) {
          result.externalizations.push(prepared);
          result.envelopeBytes += prepared.envelopeBytes;
        }
      }
    } catch (error) {
      if (error instanceof ColdArchiveBudgetError) {
        break;
      }
      if (!(error instanceof ColdArchiveLimitError)) {
        throw error;
      }
      result.oversizedTranscripts.push({
        sessionId:
          candidate.kind === "archive" ? candidate.plan.sessionId : candidate.archive.session_id,
        lowerBoundBytes: MAX_COLD_ARCHIVE_BYTES + 1,
      });
      // One event group cannot fit a file. Later windows can still archive.
      continue;
    }
  }
  const included = [
    ...result.prepared.map((item) => item.plan.sessionId),
    ...result.externalizations.map((item) => item.archive.session_id),
  ];
  if (included.length > 0) {
    const protection = withOpenClawAgentDatabaseReadOnly(
      (database) =>
        runSqliteReadSnapshotSync(
          database.db,
          () => [...readSessionAdmissionProtectionKeys(database, included)],
          { databaseLabel: database.path, operationLabel: "cold admission protection" },
        ),
      input.databaseOptions,
    );
    if (!protection.found) {
      throw new Error("Cold transcript database disappeared during preparation");
    }
    result.protectionKeys = protection.value;
  }

  return result;
}

export async function prepareSessionColdRestoreInWorker(
  plan: Extract<SessionColdMutationPlan, { kind: "cold-restore" }>,
): Promise<(database: OpenClawAgentDatabase) => Iterable<SessionColdRecord>> {
  const opened = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      executeSqliteQuerySync(
        database.db,
        getNodeSqliteKysely<DB>(database.db)
          .selectFrom("session_transcript_cold_archives")
          .selectAll()
          .where("session_id", "=", plan.sessionId),
      ).rows[0],
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
  // Verify every file before admission, retaining only metadata. Re-read each immutable
  // chunk inside the guarded transaction so an interrupted restore rolls back as a unit.
  const verify = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      runSqliteReadSnapshotSync(
        database.db,
        () => {
          for (const record of iterateSessionColdRecords(
            database.db,
            plan.databaseOptions.path,
            archive,
          )) {
            void record;
          }
        },
        { databaseLabel: database.path, operationLabel: "cold restore verification" },
      ),
    plan.databaseOptions,
  );
  if (!verify.found) {
    throw new Error("Cold transcript disappeared before restoration");
  }
  return (database) => iterateSessionColdRecords(database.db, plan.databaseOptions.path, archive);
}

export function mutateSessionColdTranscriptInWorker(
  plan: SessionColdMutationPlan,
  records: ((database: OpenClawAgentDatabase) => Iterable<SessionColdRecord>) | undefined,
  onCommit: (database: OpenClawAgentDatabase, validation?: SessionSourceValidation) => void,
  sourceGuard?: ReturnType<typeof prepareSessionColdSourceGuard>,
): SessionColdMutationResult {
  return runOpenClawAgentWriteTransaction(
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
      if (plan.kind === "cold-batch") {
        const protectionKeys = readSessionAdmissionProtectionKeys(database, [
          ...plan.prepared.map((item) => item.plan.sessionId),
          ...plan.externalizations.map((item) => item.archive.session_id),
        ]);
        if ([...protectionKeys].some((key) => !plan.protectionKeys.includes(key))) {
          throw new Error("Transcript ownership changed; cold archival was canceled");
        }
        const protectedIds = readSessionColdStorageProtection(
          database,
          plan.beforeMs,
          new Set(plan.liveSessionKeys),
        );
        const archivedIds: string[] = [];
        for (const prepared of plan.prepared) {
          const { sessionId, snapshot } = prepared.plan;
          const fresh = readSessionStateDeleteSnapshot(database.db, sessionId);
          if (
            readSessionColdTranscript(database.db, sessionId) ||
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
            executeSqliteQuerySync(
              database.db,
              db.deleteFrom("transcript_events").where("session_id", "=", sessionId),
            );
            archivedIds.push(sessionId);
            executeSqliteQuerySync(
              database.db,
              db.deleteFrom("session_transcript_index_state").where("session_id", "=", sessionId),
            );
          });
          if (fresh.sessionKey) {
            publishUnchangedSessionTranscriptAuthority(database, fresh.sessionKey);
          }
          result.archivedTranscripts++;
        }
        if (archivedIds.length > 0) {
          deleteSessionTranscriptFtsRowsInTransaction(database.db, archivedIds);
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
                  .updateTable("session_transcript_cold_archive_chunks")
                  .set({ archive_blob: null })
                  .where("session_id", "=", archive.session_id),
              );
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
          !records
        ) {
          throw new Error("Cold transcript changed during restoration");
        }
        const session_id = plan.sessionId;
        const insertFts = createSessionTranscriptFtsInserter(database.db, session_id);
        const ftsRows: Parameters<typeof insertFts>[0][number][] = [];
        withSqliteDatabaseWriteScope(database.db, [sqliteSessionIdWriteScope(session_id)], () => {
          for (const record of records(database)) {
            switch (record.kind) {
              case "header":
                break;
              case "event":
                executeSqliteQuerySync(
                  database.db,
                  db.insertInto("transcript_events").values({
                    session_id,
                    seq: record.row.seq,
                    created_at: record.row.created_at,
                    ...prepareTranscriptPayload(database.db, record.row.event_json),
                  }),
                );
                break;
              case "identity":
                executeSqliteQuerySync(
                  database.db,
                  db
                    .insertInto("transcript_event_identities")
                    .values({ session_id, ...record.row }),
                );
                break;
              case "active":
                executeSqliteQuerySync(
                  database.db,
                  db
                    .insertInto("session_transcript_active_events")
                    .values({ session_id, ...record.row }),
                );
                break;
              case "index":
                executeSqliteQuerySync(
                  database.db,
                  db
                    .insertInto("session_transcript_index_state")
                    .values({ session_id, ...record.row }),
                );
                break;
              case "fts":
                ftsRows.push({
                  messageId: record.row.message_id,
                  text: record.row.text,
                  role: record.row.role,
                  timestamp: record.row.timestamp,
                });
                if (ftsRows.length === TRANSCRIPT_INSERT_BATCH_SIZE) {
                  insertFts(ftsRows);
                  ftsRows.length = 0;
                }
                break;
            }
          }
          insertFts(ftsRows);
          executeSqliteQuerySync(
            database.db,
            db.deleteFrom("session_transcript_cold_archives").where("session_id", "=", session_id),
          );
        });
        result.restored = true;
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
    { operationLabel: "session cold storage" },
  );
}
