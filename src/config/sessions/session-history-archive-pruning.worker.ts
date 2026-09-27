import fs from "node:fs";
import path from "node:path";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import type { SqliteWalReclamationResult } from "../../infra/sqlite-wal-reclamation.js";
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
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import type {
  PublishedSessionTranscriptArchive,
  SessionLegacyArchiveRemovalResult,
} from "./session-history-archive-pruning.types.js";
import type { SessionArchivePruningWorkerInput } from "./session-transcript-worker.types.js";

export function readSessionArchivePruningInDatabase(
  database: OpenClawAgentReadOnlyDatabase,
): PublishedSessionTranscriptArchive | null {
  if (!tableExists(database.db, "session_transcript_archives")) {
    return null;
  }
  const db = getSessionKysely(database.db);
  const row = executeSqliteQuerySync(
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
      .orderBy("created_at", "asc")
      .orderBy("session_id", "asc")
      .orderBy("generation", "asc")
      .limit(1),
  ).rows[0];
  return row && row.published_at !== null ? { ...row, published_at: row.published_at } : null;
}

export function readSessionArchivePruningInWorker(
  request: SessionArchivePruningWorkerInput,
): PublishedSessionTranscriptArchive | null {
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
      const value = readSessionArchivePruningInDatabase(database);
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
  return runOpenClawAgentWriteTransaction((transactionDb) => {
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
  }, options);
}

export function deletePublishedSessionArchiveInDatabase(
  database: OpenClawAgentDatabase,
  options: OpenClawAgentDatabaseOptions,
  row: PublishedSessionTranscriptArchive,
  admit: (stage: "transaction" | "commit") => void,
): void {
  runOpenClawAgentWriteTransaction((transactionDb) => {
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
  }, options);
}

export function reclaimSessionArchivePagesInWorker(
  database: OpenClawAgentDatabase,
  maxPages: number | undefined,
  admit: (stage: "transaction" | "commit") => void,
): SqliteWalReclamationResult {
  return database.walMaintenance.reclaimFreePages({
    maxPages,
    beforeMutation: () => admit("transaction"),
    onCommit: () => admit("commit"),
  });
}
