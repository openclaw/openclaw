import { createHash } from "node:crypto";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import type {
  SessionColdArchive,
  SessionColdChunkMetadata,
} from "./session-accessor.sqlite-archive-types.js";
import {
  decodeSessionColdRecords,
  readVerifiedSessionColdArchiveSync,
  type SessionColdRecord,
} from "./session-cold-storage-codec.js";
const chunkMetadataColumns = [
  "session_id",
  "chunk_index",
  "archive_name",
  "archive_sha256",
  "first_seq",
  "last_seq",
  "event_count",
  "raw_bytes",
  "archive_bytes",
] as const;

/** Fixed field order binds the parent identity to every ordered chunk and its restore bounds. */
export function hashSessionColdChunks(chunks: readonly SessionColdChunkMetadata[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        chunks.map((chunk) => [
          chunk.chunk_index,
          chunk.archive_name,
          chunk.archive_sha256,
          chunk.first_seq,
          chunk.last_seq,
          chunk.event_count,
          chunk.raw_bytes,
          chunk.archive_bytes,
        ]),
      ),
    )
    .digest("hex");
}

export function readSessionColdChunks(
  database: EngineConnection,
  archive: Omit<SessionColdArchive, "archive_blob">,
): SessionColdChunkMetadata[] {
  const chunks = executeSqliteQuerySync(
    database,
    getNodeSqliteKysely<DB>(database)
      .selectFrom("session_transcript_cold_archive_chunks")
      .select(chunkMetadataColumns)
      .where("session_id", "=", archive.session_id)
      .orderBy("chunk_index"),
  ).rows;
  if (chunks.length === 0) {
    return chunks;
  }
  const hash = hashSessionColdChunks(chunks);
  if (
    chunks.some(
      (chunk, index) =>
        chunk.chunk_index !== index ||
        (index > 0 && chunk.first_seq <= chunks[index - 1]!.last_seq),
    ) ||
    chunks.reduce((total, chunk) => total + chunk.event_count, 0) !== archive.event_count ||
    chunks.reduce((total, chunk) => total + chunk.raw_bytes, chunks.length - 1) !==
      archive.raw_bytes ||
    chunks.reduce((total, chunk) => total + chunk.archive_bytes, 0) !== archive.archive_bytes ||
    chunks.at(-1)?.last_seq !== archive.last_seq ||
    hash !== archive.archive_sha256 ||
    `${hash}.jsonl.zst` !== archive.archive_name
  ) {
    throw new Error("Cold transcript archive chunk metadata does not match its parent");
  }
  return chunks;
}

/** The caller verifies the parent manifest once, then reads only selected immutable chunks. */
export function readVerifiedSessionColdChunk(
  database: EngineConnection,
  storePath: string,
  archive: Omit<SessionColdArchive, "archive_blob">,
  chunk?: SessionColdChunkMetadata,
) {
  const db = getNodeSqliteKysely<DB>(database);
  const embedded =
    archive.storage !== "sqlite"
      ? null
      : chunk
        ? executeSqliteQueryTakeFirstSync(
            database,
            db
              .selectFrom("session_transcript_cold_archive_chunks")
              .select("archive_blob")
              .where("session_id", "=", archive.session_id)
              .where("chunk_index", "=", chunk.chunk_index),
          )?.archive_blob
        : executeSqliteQueryTakeFirstSync(
            database,
            db
              .selectFrom("session_transcript_cold_archives")
              .select("archive_blob")
              .where("session_id", "=", archive.session_id),
          )?.archive_blob;
  return {
    bytes: readVerifiedSessionColdArchiveSync({
      storePath,
      archive: { ...(chunk ?? archive), storage: archive.storage, archive_blob: embedded ?? null },
    }),
    archive: chunk ? { ...chunk, generation: archive.generation } : archive,
  };
}

/** Verify the parent manifest and each compressed payload before restoration admission. */
export function* readVerifiedSessionColdChunks(
  database: EngineConnection,
  storePath: string,
  archive: Omit<SessionColdArchive, "archive_blob">,
  newestFirst = false,
) {
  const chunks = readSessionColdChunks(database, archive);
  if (chunks.length === 0) {
    yield readVerifiedSessionColdChunk(database, storePath, archive);
    return;
  }
  for (let offset = 0; offset < chunks.length; offset++) {
    yield readVerifiedSessionColdChunk(
      database,
      storePath,
      archive,
      chunks[newestFirst ? chunks.length - 1 - offset : offset]!,
    );
  }
}

/** Only one decompressed chunk and one parsed record are retained during restoration. */
export function* iterateSessionColdRecords(
  database: EngineConnection,
  storePath: string,
  archive: Omit<SessionColdArchive, "archive_blob">,
): Generator<SessionColdRecord> {
  for (const chunk of readVerifiedSessionColdChunks(database, storePath, archive)) {
    yield* decodeSessionColdRecords(chunk.bytes, chunk.archive);
  }
}
