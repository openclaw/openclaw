import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { requireDirectorySync, syncDirectorySync } from "../../infra/directory-durability.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
} from "../../infra/kysely-sync.js";
import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import { publishEncodedSessionTranscriptArchive } from "./session-accessor.sqlite-archive-artifact.js";
import type {
  SessionColdArchive,
  SessionColdBatchInput,
  SessionColdBatchPrepared,
  SessionColdExternalization,
  SessionColdChunkMetadata,
  SessionColdPlan,
  SessionColdPrepared,
} from "./session-accessor.sqlite-archive-types.js";
import {
  readSessionStateDeleteSnapshot,
  sqliteSessionStateDeleteSnapshotsEqual,
} from "./session-accessor.sqlite-delete-snapshot.js";
import { hashSessionColdChunks, readSessionColdChunks } from "./session-cold-storage-chunks.js";
import {
  decodeSessionColdRecords,
  MAX_COLD_ARCHIVE_BYTES,
  resolveSessionColdArchivePath,
  readVerifiedSessionColdArchive,
  verifyPublishedSessionColdArchive,
  sessionColdRecordSchema,
  type SessionColdRecord,
} from "./session-cold-storage-codec.js";
import {
  readSessionAdmissionProtectionKeys,
  selectSessionColdBatch,
} from "./session-cold-storage-selection.js";
import { selectSessionTranscriptFtsRows } from "./session-transcript-fts.js";
import { transcriptEventJsonSql } from "./transcript-payload.js";

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

function prepareSessionColdArchiveInWorker(
  plan: SessionColdPlan,
  maxEnvelopeBytes: number,
): SessionColdPrepared {
  if (!plan.snapshot.generation) {
    throw new Error("Cannot archive a transcript without its generation");
  }
  const directory = path.dirname(
    resolveSessionColdArchivePath(plan.databaseOptions.path, `${"0".repeat(64)}.jsonl.zst`),
  );
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const chunks: SessionColdChunkMetadata[] = [];
  let envelopeBytes = 0;
  const opened = withOpenClawAgentDatabaseReadOnly(
    (database) =>
      runSqliteReadSnapshotSync(
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
          const encodeRange = (sequences: number[]): void => {
            const firstSeq = sequences[0]!;
            const lastSeq = sequences.at(-1)!;
            const lines: string[] = [];
            let size = 0;
            let eventCount = 0;
            let rawBytes = 0;
            const write = (record: SessionColdRecord) => {
              const line = `${JSON.stringify(record)}\n`;
              size += Buffer.byteLength(line);
              if (size > MAX_COLD_ARCHIVE_BYTES) {
                throw new ColdArchiveLimitError();
              }
              if (envelopeBytes + size > maxEnvelopeBytes) {
                throw new ColdArchiveBudgetError();
              }
              lines.push(line);
            };
            try {
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
                  .select([
                    "seq",
                    "created_at",
                    transcriptEventJsonSql(database.db).as("event_json"),
                  ])
                  .where("session_id", "=", plan.sessionId)
                  .where("seq", ">=", firstSeq)
                  .where("seq", "<=", lastSeq)
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
                  .where("seq", ">=", firstSeq)
                  .where("seq", "<=", lastSeq)
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
                  .where("event_seq", ">=", firstSeq)
                  .where("event_seq", "<=", lastSeq)
                  .orderBy("active_position"),
              )) {
                write({ kind: "active", row });
              }
              if (lastSeq === plan.snapshot.lastSeq) {
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
              }
              const identities = db
                .selectFrom("transcript_event_identities")
                .select("event_id")
                .where("session_id", "=", plan.sessionId);
              const inRange = identities.where("seq", ">=", firstSeq).where("seq", "<=", lastSeq);
              for (const row of iterateSqliteQuerySync(
                database.db,
                selectSessionTranscriptFtsRows(database.db, plan.sessionId).where(
                  "rowid",
                  "in",
                  db
                    .selectFrom("session_transcript_fts_rows")
                    .select("id")
                    .where("session_id", "=", plan.sessionId)
                    .where((eb) =>
                      eb.or([
                        eb("message_id", "in", inRange),
                        // Legacy FTS rows without an identity still belong to this window.
                        ...(lastSeq === plan.snapshot.lastSeq
                          ? [eb("message_id", "is", null), eb("message_id", "not in", identities)]
                          : []),
                      ]),
                    ),
                ),
              )) {
                write(sessionColdRecordSchema.parse({ kind: "fts", row }));
              }
            } catch (error) {
              if (!(error instanceof ColdArchiveLimitError) || sequences.length === 1) {
                throw error;
              }
              lines.length = 0;
              const middle = Math.floor(sequences.length / 2);
              encodeRange(sequences.slice(0, middle));
              encodeRange(sequences.slice(middle));
              return;
            }
            const bytes = zlib.zstdCompressSync(Buffer.from(lines.join("")));
            const sha256 = createHash("sha256").update(bytes).digest("hex");
            const chunk: SessionColdChunkMetadata = {
              session_id: plan.sessionId,
              chunk_index: chunks.length,
              archive_name: `${sha256}.jsonl.zst`,
              archive_sha256: sha256,
              first_seq: firstSeq,
              last_seq: lastSeq,
              event_count: eventCount,
              raw_bytes: rawBytes + eventCount - 1,
              archive_bytes: bytes.length,
            };
            decodeSessionColdRecords(bytes, { ...chunk, generation: plan.snapshot.generation! });
            publishEncodedSessionTranscriptArchive({
              archiveDirectory: directory,
              archiveName: chunk.archive_name,
              bytes,
              sha256,
            });
            verifyPublishedSessionColdArchive(plan.databaseOptions.path, chunk);
            chunks.push(chunk);
            envelopeBytes += size;
          };
          let sequences: number[] = [];
          let estimatedBytes = 0;
          // Leave room for escaped JSON and restore projections; exact envelope size decides splitting.
          for (const row of iterateSqliteQuerySync(
            database.db,
            db
              .selectFrom("transcript_events")
              .select(["seq"])
              .select((eb) =>
                eb.fn
                  .coalesce("event_utf8_bytes", eb.fn<number>("octet_length", ["event_json"]))
                  .as("bytes"),
              )
              .where("session_id", "=", plan.sessionId)
              .orderBy("seq"),
          )) {
            if (sequences.length > 0 && estimatedBytes + row.bytes > MAX_COLD_ARCHIVE_BYTES / 4) {
              encodeRange(sequences);
              sequences = [];
              estimatedBytes = 0;
            }
            sequences.push(row.seq);
            estimatedBytes += row.bytes;
          }
          if (sequences.length) {
            encodeRange(sequences);
          }
        },
        { databaseLabel: database.path, operationLabel: "cold transcript snapshot" },
      ),
    plan.databaseOptions,
  );
  if (!opened.found || chunks.length === 0) {
    throw new Error("Cannot archive a missing or empty transcript");
  }
  requireDirectorySync(syncDirectorySync(directory), "Cold archive directory");
  requireDirectorySync(syncDirectorySync(path.dirname(directory)), "Session artifact directory");
  const hash = chunks.length === 1 ? chunks[0]!.archive_sha256 : hashSessionColdChunks(chunks);
  const archive: SessionColdArchive = {
    session_id: plan.sessionId,
    generation: plan.snapshot.generation,
    archive_name: `${hash}.jsonl.zst`,
    archive_sha256: hash,
    archive_bytes: chunks.reduce((sum, chunk) => sum + chunk.archive_bytes, 0),
    event_count: chunks.reduce((sum, chunk) => sum + chunk.event_count, 0),
    raw_bytes: chunks.reduce((sum, chunk) => sum + chunk.raw_bytes, chunks.length - 1),
    last_seq: plan.snapshot.lastSeq!,
    archived_at: Date.now(),
    storage: "file",
    archive_blob: null,
  };
  return { plan, archive, chunks: chunks.length > 1 ? chunks : [], envelopeBytes };
}

export class ColdArchiveLimitError extends Error {}
export class ColdArchiveBudgetError extends Error {}
