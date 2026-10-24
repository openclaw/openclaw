import fs from "node:fs";
import path from "node:path";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { isPostgresSqlConnection } from "../../infra/sql-connection.js";
import { readSqliteFreePageCount } from "../../infra/sqlite-wal-reclamation.js";
import { assertExistingDatabaseIdentity } from "../../infra/sqlite-worker-identity.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  withOpenClawAgentDatabaseReadOnly,
  type OpenClawAgentReadOnlyDatabase,
} from "../../state/openclaw-agent-db-readonly.js";
import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import { readReferencedSessionIds } from "./session-accessor.sqlite-references.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import type {
  PublishedSessionTranscriptArchive,
  SessionArchivePruningRead,
  SessionArchivePruningSnapshot,
  SessionArchiveRetentionDelete,
  SessionLegacyArchiveRemovalResult,
} from "./session-history-archive-pruning.types.js";

export function readSessionArchivePruningInDatabase(
  database: OpenClawAgentReadOnlyDatabase,
  limit = 1,
  offset = 0,
): SessionArchivePruningSnapshot {
  const freePages = isPostgresSqlConnection(database.db) ? 0 : readSqliteFreePageCount(database.db);
  if (!tableExists(database.db, "session_transcript_archives")) {
    return { archives: [], freePages };
  }
  const db = getSessionKysely(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_transcript_archives")
      .select([
        "archive_name",
        "archive_sha256",
        "created_at",
        "encoding",
        "generation",
        "published_at",
        "reason",
        "session_id",
        "session_key",
      ])
      .where("published_at", "is not", null)
      .$narrowType<{ published_at: number }>()
      .orderBy("created_at", "asc")
      .orderBy("session_id", "asc")
      .orderBy("generation", "asc")
      .limit(limit)
      .offset(offset),
  ).rows;
  return { archives: rows.map((row) => Object.assign({}, row)), freePages };
}

export function readSessionArchivePruningInWorker(
  request: SessionArchivePruningRead,
): SessionArchivePruningSnapshot {
  const identity = `file:${request.expectedIdentity.physicalIdentity}`;
  assertExistingDatabaseIdentity(request.database.path, identity);
  const result = withOpenClawAgentDatabaseReadOnly(
    (database) => {
      const current = readOpenClawAgentDatabaseIdentity(database);
      if (
        current.identity !== request.expectedIdentity.physicalIdentity ||
        current.filename !== request.expectedIdentity.nativeLocation
      ) {
        throw new Error("SQLite archive pruning database owner changed");
      }
      const value = readSessionArchivePruningInDatabase(database, request.limit, request.offset);
      assertExistingDatabaseIdentity(request.database.path, identity);
      return value;
    },
    { ...request.database, env: request.env },
  );
  if (!result.found) {
    throw new Error(`SQLite archive pruning cannot read its database: ${result.reason}`);
  }
  return result.value;
}

export function pruneSessionArchivesByRetentionInDatabase(
  database: OpenClawAgentDatabase,
  options: OpenClawAgentDatabaseOptions,
  input: SessionArchiveRetentionDelete,
  admit: (stage: "transaction" | "commit") => void,
): number {
  return runOpenClawAgentWriteTransaction(
    (transactionDb) => {
      if (transactionDb.db !== database.db) {
        throw new Error("SQLite archive pruning lost its database owner");
      }
      admit("transaction");
      const referenced = readReferencedSessionIds(
        transactionDb,
        undefined,
        input.candidates.map((row) => row.session_id),
      );
      const db = getSessionKysely(transactionDb.db);
      const directory = path.resolve(input.archiveDirectory);
      const removable = input.candidates.filter((row) => {
        const archivePath = path.resolve(directory, row.archive_name);
        return (
          !referenced.has(row.session_id) &&
          path.dirname(archivePath) === directory &&
          path.basename(archivePath) === row.archive_name &&
          !fs.existsSync(archivePath)
        );
      });
      let removed = 0;
      if (removable.length > 0) {
        // Selection can wait behind publication or restore; stale rows simply wait for another sweep.
        const result = executeSqliteQuerySync(
          transactionDb.db,
          db
            .deleteFrom("session_transcript_archives")
            .where((eb) =>
              eb.or(
                removable.map((row) =>
                  eb.and([
                    eb("session_id", "=", row.session_id),
                    eb("generation", "=", row.generation),
                    eb("archive_name", "=", row.archive_name),
                    eb("created_at", "=", row.created_at),
                    eb("published_at", "=", row.published_at),
                  ]),
                ),
              ),
            ),
        );
        removed = Number(result.numAffectedRows ?? 0n);
      }
      admit("commit");
      return removed;
    },
    options,
    { operationLabel: "session.archive.prune-retention" },
  );
}

function removeLegacyArchiveFile(
  filePath: string,
  admitCommit: () => void,
): SessionLegacyArchiveRemovalResult {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    admitCommit();
    return "failed";
  }
  if (!stat.isFile()) {
    admitCommit();
    return "failed";
  }
  // Unlink cannot roll back; authorize it while the transaction still excludes peers.
  admitCommit();
  try {
    fs.unlinkSync(filePath);
    return "removed";
  } catch {
    return "failed";
  }
}

export function removeLegacySessionArchiveInDatabase(
  database: OpenClawAgentDatabase,
  options: OpenClawAgentDatabaseOptions,
  filePath: string,
  admit: (stage: "transaction" | "commit") => void,
): SessionLegacyArchiveRemovalResult {
  return runOpenClawAgentWriteTransaction(
    (transactionDb) => {
      if (transactionDb.db !== database.db) {
        throw new Error("SQLite archive pruning lost its database owner");
      }
      admit("transaction");
      const db = getSessionKysely(transactionDb.db);
      const owned =
        tableExists(transactionDb.db, "session_transcript_archives") &&
        executeSqliteQuerySync(
          transactionDb.db,
          db
            .selectFrom("session_transcript_archives")
            .select("archive_name")
            .where("archive_name", "=", path.basename(filePath))
            .limit(1),
        ).rows.length > 0;
      if (owned) {
        admit("commit");
        return "preserved";
      }
      return removeLegacyArchiveFile(filePath, () => admit("commit"));
    },
    options,
    { operationLabel: "session.archive.remove-legacy" },
  );
}

export function deletePublishedSessionArchiveInDatabase(
  database: OpenClawAgentDatabase,
  options: OpenClawAgentDatabaseOptions,
  row: PublishedSessionTranscriptArchive,
  admit: (stage: "transaction" | "commit") => void,
): void {
  runOpenClawAgentWriteTransaction(
    (transactionDb) => {
      if (transactionDb.db !== database.db) {
        throw new Error("SQLite archive pruning lost its database owner");
      }
      admit("transaction");
      const db = getSessionKysely(transactionDb.db);
      // A peer or cold reopen may change publication while unlink is in flight.
      const deletion = executeSqliteQuerySync(
        transactionDb.db,
        db
          .deleteFrom("session_transcript_archives")
          .where("session_id", "=", row.session_id)
          .where("generation", "=", row.generation)
          .where("archive_name", "=", row.archive_name)
          .where("archive_sha256", "=", row.archive_sha256)
          .where("created_at", "=", row.created_at)
          .where("encoding", "=", row.encoding)
          .where("reason", "=", row.reason)
          .where("session_key", "=", row.session_key)
          .where("published_at", "=", row.published_at),
      );
      if (deletion.numAffectedRows !== 1n) {
        throw new Error("SQLite session archive changed during pruning; retry cleanup.");
      }
      admit("commit");
    },
    options,
    { operationLabel: "session.archive.delete-published" },
  );
}
