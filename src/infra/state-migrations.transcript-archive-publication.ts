import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { replaceFileAtomicSync } from "@openclaw/fs-safe/atomic";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveSqliteTranscriptArchiveDirectory } from "../config/sessions/session-accessor.sqlite-scope.js";
import { assertAgentDatabaseMaintenanceAuthority } from "../state/openclaw-agent-db-lease.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../state/openclaw-state-db.js";
import { VERSION } from "../version.js";
import { sha256Hex } from "./crypto-digest.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import {
  formatMigrationWarningSummary,
  MIGRATION_WARNING_EXAMPLE_LIMIT,
} from "./migration-warning-summary.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";

const TRANSCRIPT_ARCHIVE_RECOVERY_KEY = "historical-canonical-transcript-archive-recovery-v1";
export const TRANSCRIPT_ARCHIVE_MIGRATION_BATCH_SIZE = 32;

type TranscriptArchivePublicationDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "schema_meta" | "session_transcript_archives"
>;

export type TranscriptArchivePublicationPlan = {
  archiveName: string;
  nextBytes: Buffer;
  nextSha256: string;
  encoding?: "identity" | "zstd";
  fingerprint?: string;
};

export type TranscriptArchiveRecoveryRow = {
  generation: string;
  nextSha256: string;
  publishedAt: number;
  sessionId: string;
};

type TranscriptArchiveRecoveryJournal = { rows: TranscriptArchiveRecoveryRow[] };

export function transcriptArchivePathFor(archiveDirectory: string, archiveName: string): string {
  const archivePath = path.resolve(archiveDirectory, archiveName);
  if (
    path.dirname(archivePath) !== path.resolve(archiveDirectory) ||
    path.basename(archivePath) !== archiveName
  ) {
    throw new Error(`Cannot migrate transcript archive outside ${archiveDirectory}`);
  }
  return archivePath;
}

export function transcriptArchiveFingerprint(
  archivePath: string,
  sha256: string,
  encoding: string,
): string | undefined {
  let stat: fs.BigIntStats | undefined;
  try {
    stat = fs.statSync(archivePath, { bigint: true, throwIfNoEntry: false });
  } catch {
    return undefined;
  }
  return sha256Hex(
    JSON.stringify([
      VERSION,
      archivePath,
      sha256,
      encoding,
      stat ? [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String) : null,
    ]),
  );
}

export function transcriptArchiveRecoveryRowKey(
  row: Pick<TranscriptArchiveRecoveryRow, "generation" | "sessionId">,
): string {
  return `${row.sessionId}\u0000${row.generation}`;
}

export function readTranscriptArchiveRecoveryJournal(
  database: DatabaseSync,
): TranscriptArchiveRecoveryJournal | undefined {
  const db = getNodeSqliteKysely<TranscriptArchivePublicationDatabase>(database);
  const row = executeSqliteQueryTakeFirstSync(
    database,
    db
      .selectFrom("schema_meta")
      .select("app_version")
      .where("meta_key", "=", TRANSCRIPT_ARCHIVE_RECOVERY_KEY),
  );
  if (!row) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.app_version ?? "");
  } catch {
    throw new Error("Invalid transcript archive recovery journal");
  }
  if (
    !isRecord(parsed) ||
    !Array.isArray(parsed.rows) ||
    parsed.rows.length === 0 ||
    !parsed.rows.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.sessionId === "string" &&
        typeof entry.generation === "string" &&
        typeof entry.nextSha256 === "string" &&
        typeof entry.publishedAt === "number",
    )
  ) {
    throw new Error("Invalid transcript archive recovery journal");
  }
  return {
    rows: parsed.rows.map((entry) => ({
      sessionId: entry.sessionId,
      generation: entry.generation,
      nextSha256: entry.nextSha256,
      publishedAt: entry.publishedAt,
    })),
  };
}

export function writeTranscriptArchiveRecoveryJournal(
  database: DatabaseSync,
  agentId: string,
  rows: TranscriptArchiveRecoveryRow[],
): void {
  const now = Date.now();
  const appVersion = JSON.stringify({ rows });
  const db = getNodeSqliteKysely<TranscriptArchivePublicationDatabase>(database);
  executeSqliteQuerySync(
    database,
    db
      .insertInto("schema_meta")
      .values({
        agent_id: agentId,
        app_version: appVersion,
        created_at: now,
        meta_key: TRANSCRIPT_ARCHIVE_RECOVERY_KEY,
        role: "agent",
        schema_version: 1,
        updated_at: now,
      })
      .onConflict((conflict) =>
        conflict.column("meta_key").doUpdateSet({
          agent_id: agentId,
          app_version: appVersion,
          updated_at: now,
        }),
      ),
  );
}

export function clearTranscriptArchiveRecoveryJournal(database: DatabaseSync): void {
  const db = getNodeSqliteKysely<TranscriptArchivePublicationDatabase>(database);
  executeSqliteQuerySync(
    database,
    db.deleteFrom("schema_meta").where("meta_key", "=", TRANSCRIPT_ARCHIVE_RECOVERY_KEY),
  );
}

export function repairPublishedTranscriptArchive(params: {
  archiveDirectory: string;
  planned: TranscriptArchivePublicationPlan;
  signal?: AbortSignal;
  verifyOnly?: boolean;
}): boolean {
  params.signal?.throwIfAborted();
  const archiveDirectory = path.resolve(params.archiveDirectory);
  const archivePath = transcriptArchivePathFor(archiveDirectory, params.planned.archiveName);
  const fingerprint = () =>
    params.planned.encoding
      ? transcriptArchiveFingerprint(
          archivePath,
          params.planned.nextSha256,
          params.planned.encoding,
        )
      : undefined;
  const before = fingerprint();
  if (!fs.existsSync(archivePath)) {
    params.planned.fingerprint = before;
    return false;
  }
  if (before !== undefined && params.planned.fingerprint === before) {
    return true;
  }
  if (sha256Hex(fs.readFileSync(archivePath)) === params.planned.nextSha256) {
    params.planned.fingerprint = fingerprint() === before ? before : undefined;
    return true;
  }
  if (params.verifyOnly) {
    params.planned.fingerprint = undefined;
    return false;
  }
  params.signal?.throwIfAborted();
  assertAgentDatabaseMaintenanceAuthority();
  replaceFileAtomicSync({
    beforeRename: ({ tempPath }) => {
      const stagedHash = sha256Hex(fs.readFileSync(tempPath));
      if (stagedHash !== params.planned.nextSha256) {
        throw new Error(`Transcript archive staging verification failed for ${archivePath}`);
      }
      params.signal?.throwIfAborted();
      // Staging and fsync can outlive the timer-driven lease heartbeat. Recheck
      // at the atomic publication boundary so an expired owner cannot rename.
      assertAgentDatabaseMaintenanceAuthority();
    },
    content: params.planned.nextBytes,
    filePath: archivePath,
    preserveExistingMode: true,
    syncParentDir: true,
    syncTempFile: true,
    tempPrefix: `${path.basename(archivePath)}.directive-migration`,
  });
  const published = fingerprint();
  if (sha256Hex(fs.readFileSync(archivePath)) !== params.planned.nextSha256) {
    throw new Error(`Transcript archive verification failed for ${archivePath}`);
  }
  params.planned.fingerprint = fingerprint() === published ? published : undefined;
  params.signal?.throwIfAborted();
  return true;
}

// Recover the committed pending batch independently of the caller's cursor.
// Retention or insertion may change which rows fit in a later listed page.
export async function recoverTranscriptArchivePublication(params: {
  agentId: string;
  archiveDirectory: string;
  database: DatabaseSync;
  onArchive?: (archivePath: string) => void;
  pathname: string;
  signal?: AbortSignal;
}): Promise<string[]> {
  const journal = readTranscriptArchiveRecoveryJournal(params.database);
  if (!journal) {
    return [];
  }
  const db = getNodeSqliteKysely<TranscriptArchivePublicationDatabase>(params.database);
  const unresolved: TranscriptArchiveRecoveryRow[] = [];
  const missingCopyExamples: string[] = [];
  for (
    let offset = 0;
    offset < journal.rows.length;
    offset += TRANSCRIPT_ARCHIVE_MIGRATION_BATCH_SIZE
  ) {
    const batch = journal.rows.slice(offset, offset + TRANSCRIPT_ARCHIVE_MIGRATION_BATCH_SIZE);
    const ready: TranscriptArchiveRecoveryRow[] = [];
    const batchUnresolved: TranscriptArchiveRecoveryRow[] = [];
    for (const recorded of batch) {
      params.signal?.throwIfAborted();
      const row = executeSqliteQueryTakeFirstSync(
        params.database,
        db
          .selectFrom("session_transcript_archives")
          .select(["archive_blob", "archive_name", "archive_sha256", "published_at"])
          .where("session_id", "=", recorded.sessionId)
          .where("generation", "=", recorded.generation),
      );
      // Deleted, replaced, or independently republished rows no longer belong to
      // this recovery attempt. Never restore an old timestamp to new content.
      if (!row || row.archive_sha256 !== recorded.nextSha256 || row.published_at !== null) {
        continue;
      }
      const nextBytes = Buffer.from(row.archive_blob);
      const archivePath = transcriptArchivePathFor(params.archiveDirectory, row.archive_name);
      if (sha256Hex(nextBytes) !== recorded.nextSha256) {
        throw new Error(
          `Canonical SQLite transcript archive is corrupt: ${archivePath} (${recorded.sessionId}:${recorded.generation})`,
        );
      }
      params.onArchive?.(archivePath);
      const fileCurrent = repairPublishedTranscriptArchive({
        archiveDirectory: params.archiveDirectory,
        planned: { archiveName: row.archive_name, nextBytes, nextSha256: recorded.nextSha256 },
        signal: params.signal,
      });
      if (fileCurrent) {
        ready.push(recorded);
      } else {
        batchUnresolved.push(recorded);
        if (missingCopyExamples.length < MIGRATION_WARNING_EXAMPLE_LIMIT) {
          missingCopyExamples.push(`Missing canonical transcript archive copy: ${archivePath}`);
        }
      }
    }
    const remaining = journal.rows.slice(offset + batch.length);
    runSqliteImmediateTransactionSync(
      params.database,
      () => {
        params.signal?.throwIfAborted();
        assertAgentDatabaseMaintenanceAuthority();
        for (const recorded of ready) {
          executeSqliteQuerySync(
            params.database,
            db
              .updateTable("session_transcript_archives")
              .set({ published_at: recorded.publishedAt })
              .where("session_id", "=", recorded.sessionId)
              .where("generation", "=", recorded.generation)
              .where("archive_sha256", "=", recorded.nextSha256)
              .where("published_at", "is", null),
          );
        }
        const pending = [...unresolved, ...batchUnresolved, ...remaining];
        if (pending.length > 0) {
          writeTranscriptArchiveRecoveryJournal(params.database, params.agentId, pending);
        } else {
          clearTranscriptArchiveRecoveryJournal(params.database);
        }
        params.signal?.throwIfAborted();
        assertAgentDatabaseMaintenanceAuthority();
      },
      {
        busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: params.pathname,
        operationLabel: "historical-transcript-archive-recovery",
      },
    );
    unresolved.push(...batchUnresolved);
    if (remaining.length > 0) {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
  }
  return unresolved.length > 0
    ? [
        formatMigrationWarningSummary({
          summary: `${params.pathname}: Missing ${unresolved.length} canonical transcript archive file(s)`,
          count: unresolved.length,
          detail:
            "Canonical SQLite archive blobs remain retained. Migration completed without recreating the missing copies.",
        }),
        ...missingCopyExamples,
      ]
    : [];
}

export async function recoverPendingTranscriptArchivePublication(params: {
  agentId: string;
  database: DatabaseSync;
  pathname: string;
  signal?: AbortSignal;
}): Promise<string[]> {
  return recoverTranscriptArchivePublication({
    ...params,
    archiveDirectory: resolveSqliteTranscriptArchiveDirectory({
      agentId: params.agentId,
      path: params.pathname,
    }),
  });
}
