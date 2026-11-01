import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import { readSessionColdChunks } from "./session-cold-storage-chunks.js";
import { readVerifiedSessionColdArchive } from "./session-cold-storage-codec.js";

type ColdSnapshotDatabase = Pick<
  DB,
  "session_transcript_cold_archives" | "session_transcript_cold_archive_chunks"
> & {
  sqlite_schema: { name: string | null; type: string };
};

/** Embed cold files into a private snapshot before its integrity check and publication. */
export async function embedSessionColdArchivesInSnapshotInWorker(params: {
  database: DatabaseSync;
  sourceStorePath: string;
}): Promise<void> {
  const db = getNodeSqliteKysely<ColdSnapshotDatabase>(params.database);
  if (
    !executeSqliteQueryTakeFirstSync(
      params.database,
      db
        .selectFrom("sqlite_schema")
        .select("name")
        .where("type", "=", "table")
        .where("name", "=", "session_transcript_cold_archives"),
    )
  ) {
    return;
  }
  // Historical snapshots predate the chunk table and retain their single-file contract.
  const hasChunks = Boolean(
    executeSqliteQueryTakeFirstSync(
      params.database,
      db
        .selectFrom("sqlite_schema")
        .select("name")
        .where("type", "=", "table")
        .where("name", "=", "session_transcript_cold_archive_chunks"),
    ),
  );

  let previousSessionId: string | undefined;
  while (true) {
    let query = db
      .selectFrom("session_transcript_cold_archives")
      .selectAll()
      .orderBy("session_id")
      .limit(1);
    if (previousSessionId !== undefined) {
      query = query.where("session_id", ">", previousSessionId);
    }
    const archive = executeSqliteQueryTakeFirstSync(params.database, query);
    if (!archive) {
      return;
    }
    // The copied row fixes the generation. Immutable source files survive
    // restoration, so a live restore cannot invalidate this snapshot's read.
    const chunks = hasChunks ? readSessionColdChunks(params.database, archive) : [];
    for (const chunk of chunks) {
      const embedded =
        archive.storage === "sqlite"
          ? executeSqliteQueryTakeFirstSync(
              params.database,
              db
                .selectFrom("session_transcript_cold_archive_chunks")
                .select("archive_blob")
                .where("session_id", "=", archive.session_id)
                .where("chunk_index", "=", chunk.chunk_index),
            )?.archive_blob
          : null;
      const bytes = await readVerifiedSessionColdArchive({
        storePath: params.sourceStorePath,
        archive: { ...chunk, storage: archive.storage, archive_blob: embedded ?? null },
      });
      if (archive.storage === "file") {
        executeSqliteQuerySync(
          params.database,
          db
            .updateTable("session_transcript_cold_archive_chunks")
            .set({ archive_blob: bytes })
            .where("session_id", "=", archive.session_id)
            .where("chunk_index", "=", chunk.chunk_index),
        );
      }
    }
    const bytes =
      chunks.length > 0
        ? Buffer.alloc(0)
        : await readVerifiedSessionColdArchive({ storePath: params.sourceStorePath, archive });
    if (archive.storage === "file") {
      executeSqliteQuerySync(
        params.database,
        db
          .updateTable("session_transcript_cold_archives")
          .set({ storage: "sqlite", archive_blob: bytes })
          .where("session_id", "=", archive.session_id),
      );
    }
    previousSessionId = archive.session_id;
  }
}
