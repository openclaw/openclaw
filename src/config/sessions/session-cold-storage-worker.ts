import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import { requireDirectorySync, syncDirectorySync } from "../../infra/directory-durability.js";
import { hasErrnoCode } from "../../infra/errno.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import { readSessionGoalOperationInDatabase } from "./goals-operations.js";
import { publishEncodedSessionTranscriptArchive } from "./session-accessor.sqlite-archive-artifact.js";
import {
  readSessionStateDeleteSnapshot,
  sqliteSessionStateDeleteSnapshotsEqual,
} from "./session-accessor.sqlite-delete-snapshot.js";
import type { SessionStateDeleteSnapshot } from "./session-accessor.sqlite-delete-snapshot.types.js";
import { resolveTranscriptAppendRefusal } from "./session-accessor.sqlite-transcript-write-guard.js";
import {
  readVerifiedSessionColdArchive,
  resolveSessionColdArchivePath,
  sessionColdRecordSchema,
  verifyPublishedSessionColdArchive,
  type SessionColdRecord,
} from "./session-cold-storage-codec.js";
import { readSessionColdStorageProtection } from "./session-cold-storage-eligibility.js";
import type { SessionColdRestorationGuard } from "./session-cold-storage-guard.types.js";
import { readSessionColdStorageInventory } from "./session-cold-storage-inventory.js";
import {
  readSessionAdmissionProtectionKeys,
  selectSessionColdBatch,
  type SessionColdBatchInput,
} from "./session-cold-storage-selection.js";
import {
  readSessionColdLockedValidation,
  type prepareSessionColdSourceGuard,
  type SessionColdSourceMatches,
} from "./session-cold-storage-source-guard.worker.js";
import {
  readSessionColdTranscript,
  type SessionColdArchive,
} from "./session-cold-storage-state.js";
import type { SessionColdMutationResult } from "./session-cold-storage.types.js";
import type { SessionSourceValidation } from "./session-source-authority.js";
import { readSessionSourceValidation } from "./session-source-predicate.worker.js";
import {
  createSessionTranscriptFtsInserter,
  deleteSessionTranscriptFtsRowsInTransaction,
  selectSessionTranscriptFtsRows,
} from "./session-transcript-fts.js";
import {
  createSessionTranscriptTurnKernel,
  sqliteSessionTranscriptTurnRebound,
} from "./session-turn.kernel.js";
import { resolveSessionWorkStartError } from "./session-work-start.js";
import { prepareTranscriptPayload, transcriptEventJsonSql } from "./transcript-payload.js";

const MAX_COLD_ARCHIVE_BYTES = 64 * 1024 * 1024;

type SessionColdPlan = {
  databaseOptions: OpenClawAgentDatabaseOptions & { path: string };
  sessionId: string;
  snapshot: SessionStateDeleteSnapshot;
};
type SessionColdPrepared = {
  plan: SessionColdPlan;
  archive: SessionColdArchive;
  envelopeBytes: number;
};
type SessionColdExternalization = {
  archive: Omit<SessionColdArchive, "archive_blob">;
  envelopeBytes: number;
};
export type SessionColdPreparationWorkerData = {
  type: "sqlite-transcript-archive-v2";
  operation: "cold-prepare";
  input: SessionColdBatchInput;
};
export type SessionColdBatchPrepared = {
  freePages: number;
  protectionKeys: string[];
  prepared: SessionColdPrepared[];
  externalizations: SessionColdExternalization[];
  oversizedSessionIds: string[];
  envelopeBytes: number;
};
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
  type: "sqlite-transcript-archive-v2";
  operation: "cold-mutate";
  commitGate: SharedArrayBuffer;
  sourceMatches?: SessionColdSourceMatches;
  plan: SessionColdMutationPlan;
};

async function prepareSessionColdArchiveInWorker(
  plan: SessionColdPlan,
  maxBytes: number,
): Promise<SessionColdPrepared> {
  if (!plan.snapshot.generation) {
    throw new Error("Cannot archive a transcript without its generation");
  }
  const directory = path.dirname(
    resolveSessionColdArchivePath(plan.databaseOptions.path, `${"0".repeat(64)}.jsonl.zst`),
  );
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stagePath = path.join(directory, `${randomUUID()}.tmp`);
  const compressedPath = `${stagePath}.zst`;
  let eventCount = 0;
  let rawBytes = 0;
  let stagedBytes = 0;
  try {
    const fd = fs.openSync(stagePath, "wx", 0o600);
    try {
      let pending = "";
      const write = (record: SessionColdRecord) => {
        const line = `${JSON.stringify(record)}\n`;
        stagedBytes += Buffer.byteLength(line);
        if (stagedBytes > maxBytes) {
          throw new ColdArchiveLimitError();
        }
        pending += line;
        if (pending.length >= 64 * 1024) {
          fs.writeSync(fd, pending);
          pending = "";
        }
      };
      const opened = withOpenClawAgentDatabaseReadOnly(
        (database) =>
          runSqliteDeferredTransactionSync(
            database.db,
            () => {
              if (
                !sqliteSessionStateDeleteSnapshotsEqual(
                  readSessionStateDeleteSnapshot(database.db, plan.sessionId),
                  plan.snapshot,
                )
              ) {
                throw new Error("Transcript changed before cold archive preparation");
              }
              const db = getNodeSqliteKysely<DB>(database.db);
              write({
                kind: "header",
                version: 1,
                sessionId: plan.sessionId,
                generation: plan.snapshot.generation!,
              });
              for (const row of iterateSqliteQuerySync(
                database.db,
                db
                  .selectFrom("transcript_events")
                  .select("seq")
                  .select(transcriptEventJsonSql(database.db).as("event_json"))
                  .select("created_at")
                  .where("session_id", "=", plan.sessionId)
                  .orderBy("seq"),
              )) {
                eventCount++;
                rawBytes += Buffer.byteLength(row.event_json);
                write({ kind: "event", row });
              }
              for (const row of iterateSqliteQuerySync(
                database.db,
                db
                  .selectFrom("transcript_event_identities")
                  .select([
                    "event_id",
                    "seq",
                    "event_type",
                    "parent_id",
                    "message_idempotency_key",
                    "created_at",
                  ])
                  .where("session_id", "=", plan.sessionId)
                  .orderBy("seq")
                  .orderBy("event_id"),
              )) {
                write({ kind: "identity", row });
              }
              for (const row of iterateSqliteQuerySync(
                database.db,
                db
                  .selectFrom("session_transcript_active_events")
                  .select(["active_position", "event_seq", "message_position", "context_eligible"])
                  .where("session_id", "=", plan.sessionId)
                  .orderBy("active_position"),
              )) {
                write({ kind: "active", row });
              }
              for (const row of iterateSqliteQuerySync(
                database.db,
                db
                  .selectFrom("session_transcript_index_state")
                  .select([
                    "indexed_seq",
                    "leaf_event_id",
                    "needs_rebuild",
                    "active_event_count",
                    "active_message_count",
                    "updated_at",
                  ])
                  .where("session_id", "=", plan.sessionId),
              )) {
                write({ kind: "index", row });
              }
              for (const row of iterateSqliteQuerySync(
                database.db,
                selectSessionTranscriptFtsRows(database.db, plan.sessionId),
              )) {
                write(sessionColdRecordSchema.parse({ kind: "fts", row }));
              }
            },
            { databaseLabel: database.path, operationLabel: "cold transcript snapshot" },
          ),
        plan.databaseOptions,
      );
      if (!opened.found || eventCount === 0) {
        throw new Error("Cannot archive a missing or empty transcript");
      }
      if (pending) {
        fs.writeSync(fd, pending);
      }
    } finally {
      fs.closeSync(fd);
    }
    await pipeline(
      fs.createReadStream(stagePath),
      zlib.createZstdCompress(),
      fs.createWriteStream(compressedPath, { flags: "wx", mode: 0o600 }),
    );
    const bytes = fs.readFileSync(compressedPath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const archiveName = `${sha256}.jsonl.zst`;
    publishEncodedSessionTranscriptArchive({
      archiveDirectory: directory,
      archiveName,
      bytes,
      sha256,
    });
    requireDirectorySync(syncDirectorySync(directory), "Cold archive directory");
    requireDirectorySync(syncDirectorySync(path.dirname(directory)), "Session artifact directory");
    // Decode before deleting the only hot copy, including the envelope's row contracts.
    const archive: SessionColdArchive = {
      session_id: plan.sessionId,
      generation: plan.snapshot.generation,
      archive_name: archiveName,
      archive_sha256: sha256,
      archive_bytes: bytes.length,
      event_count: eventCount,
      raw_bytes: rawBytes + eventCount - 1,
      last_seq: plan.snapshot.lastSeq!,
      archived_at: Date.now(),
      storage: "file",
      archive_blob: null,
    };
    decodeSessionColdRecords(bytes, archive);
    return { plan, archive, envelopeBytes: stagedBytes };
  } finally {
    fs.rmSync(stagePath, { force: true });
    fs.rmSync(compressedPath, { force: true });
  }
}

class ColdArchiveLimitError extends Error {}

async function prepareExternalization(
  input: SessionColdBatchInput,
  expected: Omit<SessionColdArchive, "archive_blob">,
  maxBytes: number,
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
  const bytes = await readVerifiedSessionColdArchive({
    storePath: input.databaseOptions.path,
    archive,
  });
  let envelopeBytes: number;
  try {
    envelopeBytes = zlib.zstdDecompressSync(bytes, { maxOutputLength: maxBytes }).byteLength;
  } catch (error) {
    if (hasErrnoCode(error, "ERR_BUFFER_TOO_LARGE")) {
      throw new ColdArchiveLimitError();
    }
    throw error;
  }
  const directory = path.dirname(
    resolveSessionColdArchivePath(input.databaseOptions.path, archive.archive_name),
  );
  publishEncodedSessionTranscriptArchive({
    archiveDirectory: directory,
    archiveName: archive.archive_name,
    bytes,
    sha256: archive.archive_sha256,
  });
  requireDirectorySync(syncDirectorySync(directory), "Cold archive directory");
  requireDirectorySync(syncDirectorySync(path.dirname(directory)), "Session artifact directory");
  return { archive: expected, envelopeBytes };
}

export async function prepareSessionColdBatchInWorker(
  input: SessionColdBatchInput,
): Promise<SessionColdBatchPrepared> {
  const result: SessionColdBatchPrepared = {
    freePages: 0,
    protectionKeys: [],
    prepared: [],
    externalizations: [],
    oversizedSessionIds: [],
    envelopeBytes: 0,
  };
  const selection = selectSessionColdBatch(input);
  if (!selection.found) {
    return result;
  }
  result.freePages = selection.value.freePages;
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
    try {
      if (candidate.kind === "archive") {
        const prepared = await prepareSessionColdArchiveInWorker(candidate.plan, remaining);
        result.prepared.push(prepared);
        result.envelopeBytes += prepared.envelopeBytes;
      } else {
        const prepared = await prepareExternalization(input, candidate.archive, remaining);
        if (prepared) {
          result.externalizations.push(prepared);
          result.envelopeBytes += prepared.envelopeBytes;
        }
      }
    } catch (error) {
      if (!(error instanceof ColdArchiveLimitError)) {
        throw error;
      }
      if (remaining === MAX_COLD_ARCHIVE_BYTES) {
        result.oversizedSessionIds.push(
          candidate.kind === "archive" ? candidate.plan.sessionId : candidate.archive.session_id,
        );
      }
      // A rejected partial envelope consumed the remaining preparation budget too.
      result.envelopeBytes = maxBytes;
      break;
    }
  }
  const included = [
    ...result.prepared.map((item) => item.plan.sessionId),
    ...result.externalizations.map((item) => item.archive.session_id),
  ];
  if (included.length > 0) {
    const protection = withOpenClawAgentDatabaseReadOnly(
      (database) =>
        runSqliteDeferredTransactionSync(
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

function decodeSessionColdRecords(
  bytes: Uint8Array,
  archive: SessionColdArchive,
): SessionColdRecord[] {
  const records = zlib
    .zstdDecompressSync(bytes, { maxOutputLength: MAX_COLD_ARCHIVE_BYTES })
    .toString("utf8")
    .trimEnd()
    .split("\n")
    .map((line) => sessionColdRecordSchema.parse(JSON.parse(line)));
  const header = records[0];
  const events = records.filter((record) => record.kind === "event");
  if (
    header?.kind !== "header" ||
    header.sessionId !== archive.session_id ||
    header.generation !== archive.generation ||
    records.slice(1).some((record) => record.kind === "header") ||
    events.length !== archive.event_count ||
    events.at(-1)?.row.seq !== archive.last_seq ||
    events.reduce((sum, event) => sum + Buffer.byteLength(event.row.event_json), 0) +
      events.length -
      1 !==
      archive.raw_bytes
  ) {
    throw new Error("Cold transcript archive metadata does not match its contents");
  }
  return records;
}

export async function prepareSessionColdRestoreInWorker(
  plan: Extract<SessionColdMutationPlan, { kind: "cold-restore" }>,
): Promise<SessionColdRecord[]> {
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
  return decodeSessionColdRecords(
    await readVerifiedSessionColdArchive({ storePath: plan.databaseOptions.path, archive }),
    archive,
  );
}

export function mutateSessionColdTranscriptInWorker(
  plan: SessionColdMutationPlan,
  records: SessionColdRecord[] | undefined,
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
          verifyPublishedSessionColdArchive(plan.databaseOptions.path, prepared.archive);
          executeSqliteQuerySync(
            database.db,
            db.insertInto("session_transcript_cold_archives").values(prepared.archive),
          );
          executeSqliteQuerySync(
            database.db,
            db.deleteFrom("transcript_events").where("session_id", "=", sessionId),
          );
          archivedIds.push(sessionId);
          executeSqliteQuerySync(
            database.db,
            db.deleteFrom("session_transcript_index_state").where("session_id", "=", sessionId),
          );
          result.archivedTranscripts++;
        }
        if (archivedIds.length > 0) {
          deleteSessionTranscriptFtsRowsInTransaction(database.db, archivedIds);
        }
        for (const { archive } of plan.externalizations) {
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
          verifyPublishedSessionColdArchive(plan.databaseOptions.path, archive);
          executeSqliteQuerySync(
            database.db,
            db
              .updateTable("session_transcript_cold_archives")
              .set({ storage: "file", archive_blob: null })
              .where("session_id", "=", archive.session_id),
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
        for (const record of records) {
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
                db.insertInto("transcript_event_identities").values({ session_id, ...record.row }),
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
              insertFts({
                messageId: record.row.message_id,
                text: record.row.text,
                role: record.row.role,
                timestamp: record.row.timestamp,
              });
              break;
          }
        }
        executeSqliteQuerySync(
          database.db,
          db.deleteFrom("session_transcript_cold_archives").where("session_id", "=", session_id),
        );
        result.restored = true;
        result.sessionKey = executeSqliteQueryTakeFirstSync(
          database.db,
          db
            .selectFrom("session_windows")
            .select("session_key")
            .where("session_id", "=", session_id),
        )?.session_key;
      }
      onCommit(database, sourceValidation);
      sourceGuard?.assertForeign();
      return result;
    },
    plan.databaseOptions,
    { operationLabel: "session cold storage" },
  );
}

export function readSessionColdStorageInventoryInWorker(options: OpenClawAgentDatabaseOptions) {
  const counts = withOpenClawAgentDatabaseReadOnly(readSessionColdStorageInventory, options);
  return counts.found ? counts.value : readSessionColdStorageInventory();
}

export function readSessionColdMetadataInWorker(
  options: OpenClawAgentDatabaseOptions,
  sessionId: string,
) {
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) => readSessionColdTranscript(database.db, sessionId),
    options,
  );
  return result.found ? result.value : undefined;
}
