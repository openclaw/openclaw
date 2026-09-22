import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
} from "../../infra/kysely-sync.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { ensureSessionTranscriptArchiveSchema } from "../../state/openclaw-agent-session-transcript-archive-schema.js";
import { resolveRegisteredSqliteTranscriptArchiveName } from "./session-accessor.sqlite-archive-artifact.js";
import type {
  TranscriptArchivePublishPlan,
  TranscriptArchivePublishResult,
} from "./session-accessor.sqlite-archive-types.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";

const PENDING_ARCHIVE_PUBLISH_BATCH_SIZE = 4;

// Composite map keys keep repeated physical IDs distinct across transcript rewrites.
export function transcriptArchiveIdentityKey(sessionId: string, generation: string): string {
  return `${sessionId}\u0000${generation}`;
}

// Retain one publication plan per immutable archive identity.
export function uniqueTranscriptArchives<T extends { generation: string; sessionId: string }>(
  archives: readonly T[],
): T[] {
  return [
    ...new Map(
      archives.map((archive) => [
        transcriptArchiveIdentityKey(archive.sessionId, archive.generation),
        archive,
      ]),
    ).values(),
  ];
}

export function prepareSessionTranscriptArchivePublishPlans(
  database: OpenClawAgentDatabase,
  params: {
    archiveDirectory: string;
    requested: readonly Pick<TranscriptArchivePublishPlan, "sessionId" | "generation">[];
  },
): TranscriptArchivePublishPlan[] {
  const db = getSessionKysely(database.db);
  if (params.requested.length > 0) {
    ensureSessionTranscriptArchiveSchema(database.db);
  } else {
    const exists = executeSqliteQueryTakeFirstSync(
      database.db,
      db
        .selectFrom("sqlite_schema")
        .select("name")
        .where("type", "=", "table")
        .where("name", "=", "session_transcript_archives"),
    );
    if (!exists) {
      return [];
    }
  }
  const pendingArchives = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_transcript_archives")
      .select(["archive_name", "created_at", "encoding", "generation", "reason", "session_id"])
      .where("published_at", "is", null)
      .orderBy("created_at", "asc")
      .orderBy("session_id", "asc")
      .orderBy("generation", "asc")
      .limit(PENDING_ARCHIVE_PUBLISH_BATCH_SIZE),
  ).rows;
  for (const archive of pendingArchives) {
    if (
      (archive.encoding !== "identity" && archive.encoding !== "zstd") ||
      (archive.reason !== "deleted" && archive.reason !== "reset")
    ) {
      throw new Error(`Invalid pending SQLite transcript archive for ${archive.session_id}`);
    }
    // Stable builds could commit an oversized raw name before file publication.
    // Only pending rows can change names without orphaning a published file.
    const archiveName = resolveRegisteredSqliteTranscriptArchiveName({
      createdAt: archive.created_at,
      encoding: archive.encoding,
      generation: archive.generation,
      reason: archive.reason,
      sessionId: archive.session_id,
    });
    if (archiveName === archive.archive_name) {
      continue;
    }
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("session_transcript_archives")
        .set({ archive_name: archiveName })
        .where("session_id", "=", archive.session_id)
        .where("generation", "=", archive.generation)
        .where("published_at", "is", null),
    );
  }
  const archives = uniqueTranscriptArchives([
    ...params.requested,
    ...pendingArchives.map((archive) => ({
      generation: archive.generation,
      sessionId: archive.session_id,
    })),
  ]);
  return archives.map((archive) => ({
    agentId: database.agentId,
    archiveDirectory: params.archiveDirectory,
    databasePath: database.path,
    generation: archive.generation,
    sessionId: archive.sessionId,
  }));
}

// The caller owns write admission and the transaction for this result batch.
export function recordSessionTranscriptArchivePublishResults(
  database: OpenClawAgentDatabase,
  results: readonly TranscriptArchivePublishResult[],
  nowMs: number,
): void {
  ensureSessionTranscriptArchiveSchema(database.db);
  const db = getSessionKysely(database.db);
  for (const result of results) {
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("session_transcript_archives")
        .set((eb) => ({
          last_publish_attempt_at: nowMs,
          last_publish_error: result.error?.slice(0, 1024) ?? null,
          publish_attempts: eb("publish_attempts", "+", 1),
          ...(result.archivedPath ? { published_at: nowMs } : {}),
        }))
        .where("session_id", "=", result.sessionId)
        .where("generation", "=", result.generation),
    );
  }
}
