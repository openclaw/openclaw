import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import { requireDirectorySync, syncDirectorySync } from "../../infra/directory-durability.js";
import { hasErrnoCode } from "../../infra/errno.js";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
  sqliteStringSet,
} from "../../infra/kysely-sync.js";
import { runSqliteDeferredTransactionSync } from "../../infra/sqlite-transaction.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import { publishEncodedSessionTranscriptArchive } from "./session-accessor.sqlite-archive.js";
import {
  readSessionStateDeleteSnapshot,
  sqliteSessionStateDeleteSnapshotsEqual,
} from "./session-accessor.sqlite-delete-snapshot.js";
import type { SessionStateDeleteSnapshot } from "./session-accessor.sqlite-delete-snapshot.types.js";
import {
  readVerifiedSessionColdArchive,
  resolveSessionColdArchivePath,
  sessionColdRecordSchema,
  type SessionColdRecord,
} from "./session-cold-storage-codec.js";
import { readSessionColdStorageProtection } from "./session-cold-storage-eligibility.js";
import {
  readSessionColdTranscript,
  type SessionColdArchive,
} from "./session-cold-storage-state.js";

// FTS5 has no type affinity: deployed writers persist timestamps as numbers or text.
type ColdArchiveDatabase = Omit<DB, "session_transcript_fts"> & {
  session_transcript_fts: Omit<DB["session_transcript_fts"], "timestamp"> & {
    timestamp: string | number | null;
  };
};

const MAX_COLD_ARCHIVE_BYTES = 64 * 1024 * 1024;

type SessionColdPlan = {
  databaseOptions: OpenClawAgentDatabaseOptions & { path: string };
  sessionId: string;
  beforeMs: number;
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
export type SessionColdBatchInput = {
  databaseOptions: SessionColdPlan["databaseOptions"];
  plans: SessionColdPlan[];
  externalizations: Array<Omit<SessionColdArchive, "archive_blob">>;
  maxBytes: number;
};
export type SessionColdPreparationWorkerData = {
  type: "sqlite-transcript-archive-v2";
  operation: "cold-prepare";
  input: SessionColdBatchInput;
};
export type SessionColdBatchPrepared = {
  prepared: SessionColdPrepared[];
  externalizations: SessionColdExternalization[];
  oversizedSessionIds: string[];
  envelopeBytes: number;
};
export type SessionColdMutationResult = {
  archivedTranscripts: number;
  externalizedTranscripts: number;
  restored: boolean;
};
export type SessionColdMutationPlan = { databaseOptions: SessionColdPlan["databaseOptions"] } & (
  | { kind: "cold-maintain" }
  | {
      kind: "cold-batch";
      prepared: SessionColdPrepared[];
      externalizations: SessionColdExternalization[];
      beforeMs: number;
    }
  | { kind: "cold-restore"; sessionId: string; archive: Omit<SessionColdArchive, "archive_blob"> }
);
export type SessionColdWorkerData = {
  type: "sqlite-transcript-archive-v2";
  operation: "cold-mutate";
  commitGate: SharedArrayBuffer;
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
              const db = getNodeSqliteKysely<ColdArchiveDatabase>(database.db);
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
                  .select(["seq", "event_json", "created_at"])
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
                db
                  .selectFrom("session_transcript_fts")
                  .select(["text", "message_id", "role", "timestamp"])
                  .where("session_id", "=", plan.sessionId),
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
        getNodeSqliteKysely<ColdArchiveDatabase>(database.db)
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
    prepared: [],
    externalizations: [],
    oversizedSessionIds: [],
    envelopeBytes: 0,
  };
  const maxBytes = Math.min(input.maxBytes, MAX_COLD_ARCHIVE_BYTES);
  const candidates = [
    ...input.externalizations.map((archive) => ({ kind: "externalize" as const, archive })),
    ...input.plans.map((plan) => ({ kind: "archive" as const, plan })),
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
        getNodeSqliteKysely<ColdArchiveDatabase>(database.db)
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

function verifyPublishedArchive(
  storePath: string,
  archive: Omit<SessionColdArchive, "archive_blob">,
): void {
  const published = fs.readFileSync(resolveSessionColdArchivePath(storePath, archive.archive_name));
  if (
    published.length !== archive.archive_bytes ||
    createHash("sha256").update(published).digest("hex") !== archive.archive_sha256
  ) {
    throw new Error("Cold archive changed before publication; its SQLite copy was retained");
  }
}

export function mutateSessionColdTranscriptInWorker(
  plan: SessionColdMutationPlan,
  records: SessionColdRecord[] | undefined,
  onCommit: (database: OpenClawAgentDatabase) => void,
): SessionColdMutationResult {
  return runOpenClawAgentWriteTransaction(
    (database) => {
      const db = getNodeSqliteKysely<ColdArchiveDatabase>(database.db);
      const result: SessionColdMutationResult = {
        archivedTranscripts: 0,
        externalizedTranscripts: 0,
        restored: false,
      };
      if (plan.kind === "cold-maintain") {
        onCommit(database);
        return result;
      }
      if (plan.kind === "cold-batch") {
        const protectedIds = readSessionColdStorageProtection(database, plan.beforeMs);
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
          verifyPublishedArchive(plan.databaseOptions.path, prepared.archive);
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
          // FTS5 session_id is unindexed; scan once for the committed batch, not once per transcript.
          executeSqliteQuerySync(
            database.db,
            db
              .deleteFrom("session_transcript_fts")
              .where("session_id", "in", sqliteStringSet(archivedIds)),
          );
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
          verifyPublishedArchive(plan.databaseOptions.path, archive);
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
        for (const record of records) {
          switch (record.kind) {
            case "header":
              break;
            case "event":
              executeSqliteQuerySync(
                database.db,
                db.insertInto("transcript_events").values({ session_id, ...record.row }),
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
              executeSqliteQuerySync(
                database.db,
                db.insertInto("session_transcript_fts").values({ session_id, ...record.row }),
              );
              break;
          }
        }
        executeSqliteQuerySync(
          database.db,
          db.deleteFrom("session_transcript_cold_archives").where("session_id", "=", session_id),
        );
        result.restored = true;
      }
      onCommit(database);
      return result;
    },
    plan.databaseOptions,
    { operationLabel: "session cold storage" },
  );
}
