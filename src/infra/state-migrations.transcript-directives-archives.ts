import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { replaceFileAtomicSync } from "@openclaw/fs-safe/atomic";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  decodeSessionArchiveBytes,
  encodeSessionArchiveContent,
  SESSION_ARCHIVE_ZSTD_SUFFIX,
} from "../config/sessions/archive-compression.js";
import { resolveSqliteTranscriptArchiveDirectory } from "../config/sessions/session-accessor.sqlite-scope.js";
import { assertAgentDatabaseMaintenanceAuthority } from "../state/openclaw-agent-db-lease.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import { SESSION_TRANSCRIPT_ARCHIVES_TABLE } from "../state/openclaw-agent-session-transcript-archive-schema.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../state/openclaw-state-db.js";
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
import {
  parseDirectiveMigrationTranscriptEvent,
  transformHistoricalTranscriptEvent,
} from "./state-migrations.transcript-directives-transform.js";

export const TRANSCRIPT_DIRECTIVE_MIGRATION_BATCH_SIZE = 32;
const ARCHIVE_RECOVERY_KEY = "historical-canonical-transcript-archive-recovery-v1";

type TranscriptArchiveMigrationDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "schema_meta" | "session_transcript_archives"
>;

type ArchiveCursor = { generation: string; sessionId: string };

type ArchiveContentTransform = (
  content: string,
  owner: string,
) => { changed: boolean; content: string };

type ArchiveMigrationOptions = {
  agentId: string;
  database: DatabaseSync;
  pathname: string;
  start: ArchiveCursor;
  writeCursor: (cursor: ArchiveCursor | { phase: "complete" }) => void;
};

type ArchiveMigrationResult = {
  rewrittenArchives: number;
  warnings: string[];
};

type ArchiveRowPlan = {
  archiveName: string;
  archiveSha256: string;
  bytes: Buffer;
  changed: boolean;
  encoding: "identity" | "zstd";
  generation: string;
  nextBytes: Buffer;
  nextSha256: string;
  publishedAt: number | null;
  sessionId: string;
};

type ArchiveRecoveryRow = {
  generation: string;
  nextSha256: string;
  publishedAt: number;
  sessionId: string;
};

type ArchiveRecoveryJournal = { rows: ArchiveRecoveryRow[] };

function archiveRecoveryRowKey(row: Pick<ArchiveRecoveryRow, "generation" | "sessionId">): string {
  return `${row.sessionId}\u0000${row.generation}`;
}

function readArchiveRecoveryJournal(
  database: DatabaseSync,
  recoveryKey: string,
): ArchiveRecoveryJournal | undefined {
  const db = getNodeSqliteKysely<TranscriptArchiveMigrationDatabase>(database);
  const row = executeSqliteQueryTakeFirstSync(
    database,
    db.selectFrom("schema_meta").select("app_version").where("meta_key", "=", recoveryKey),
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

function writeArchiveRecoveryJournal(
  database: DatabaseSync,
  agentId: string,
  recoveryKey: string,
  journal: ArchiveRecoveryJournal,
): void {
  const now = Date.now();
  const db = getNodeSqliteKysely<TranscriptArchiveMigrationDatabase>(database);
  executeSqliteQuerySync(
    database,
    db
      .insertInto("schema_meta")
      .values({
        agent_id: agentId,
        app_version: JSON.stringify(journal),
        created_at: now,
        meta_key: recoveryKey,
        role: "agent",
        schema_version: 1,
        updated_at: now,
      })
      .onConflict((conflict) =>
        conflict.column("meta_key").doUpdateSet({
          agent_id: agentId,
          app_version: JSON.stringify(journal),
          updated_at: now,
        }),
      ),
  );
}

function clearArchiveRecoveryJournal(database: DatabaseSync, recoveryKey: string): void {
  const db = getNodeSqliteKysely<TranscriptArchiveMigrationDatabase>(database);
  executeSqliteQuerySync(
    database,
    db.deleteFrom("schema_meta").where("meta_key", "=", recoveryKey),
  );
}

function transformArchiveContent(
  content: string,
  owner: string,
): {
  changed: boolean;
  content: string;
} {
  if (!content) {
    return { changed: false, content };
  }
  const trailingNewline = content.endsWith("\n");
  const lines = trailingNewline ? content.slice(0, -1).split("\n") : content.split("\n");
  let changed = false;
  const rewritten = lines.map((line, index) => {
    if (!line) {
      throw new Error(`${owner} contains a blank JSONL record at line ${index + 1}`);
    }
    const event = parseDirectiveMigrationTranscriptEvent(line, `${owner}:${index + 1}`);
    const transformed = transformHistoricalTranscriptEvent(event);
    changed ||= transformed.changed;
    return transformed.changed ? JSON.stringify(transformed.event) : line;
  });
  return {
    changed,
    content: `${rewritten.join("\n")}${trailingNewline ? "\n" : ""}`,
  };
}

function encodeArchiveContent(
  content: string,
  encoding: "identity" | "zstd",
  owner: string,
): Buffer {
  if (encoding === "identity") {
    return Buffer.from(content, "utf8");
  }
  const encoded = encodeSessionArchiveContent(content);
  if (encoded.suffix !== SESSION_ARCHIVE_ZSTD_SUFFIX) {
    throw new Error(`${owner} could not be re-encoded with its zstd codec`);
  }
  return encoded.bytes;
}

function readArchiveEncoding(value: string, owner: string): "identity" | "zstd" {
  if (value === "identity" || value === "zstd") {
    return value;
  }
  throw new Error(`${owner} has unsupported transcript archive encoding ${value}`);
}

function listArchiveBatch(
  database: DatabaseSync,
  cursor: ArchiveCursor,
  transformContent: ArchiveContentTransform = transformArchiveContent,
): ArchiveRowPlan[] {
  // The archive table was added lazily at agent schema v17, so valid v17 databases may omit it.
  const hasArchiveTable = database
    .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(SESSION_TRANSCRIPT_ARCHIVES_TABLE);
  if (!hasArchiveTable) {
    return [];
  }
  const db = getNodeSqliteKysely<TranscriptArchiveMigrationDatabase>(database);
  let query = db
    .selectFrom("session_transcript_archives")
    .select([
      "archive_blob",
      "archive_name",
      "archive_sha256",
      "encoding",
      "generation",
      "published_at",
      "session_id",
    ])
    .orderBy("session_id", "asc")
    .orderBy("generation", "asc")
    .limit(TRANSCRIPT_DIRECTIVE_MIGRATION_BATCH_SIZE);
  if (cursor.sessionId) {
    // Seek the composite key; OR branches rescan the visited prefix on every page.
    query = query.where((eb) =>
      eb(
        eb.refTuple("session_id", "generation"),
        ">",
        eb.tuple(cursor.sessionId, cursor.generation),
      ),
    );
  }
  return executeSqliteQuerySync(database, query).rows.map((row) => {
    const owner = `${row.session_id}:${row.generation}`;
    const encoding = readArchiveEncoding(row.encoding, owner);
    const bytes = Buffer.from(row.archive_blob);
    if (sha256Hex(bytes) !== row.archive_sha256) {
      throw new Error(`Canonical SQLite transcript archive is corrupt for ${row.session_id}`);
    }
    const content = decodeSessionArchiveBytes(bytes, encoding === "zstd");
    const transformed = transformContent(content, owner);
    const nextBytes = transformed.changed
      ? encodeArchiveContent(transformed.content, encoding, owner)
      : bytes;
    return {
      archiveName: row.archive_name,
      archiveSha256: row.archive_sha256,
      bytes,
      changed: transformed.changed,
      encoding,
      generation: row.generation,
      nextBytes,
      nextSha256: sha256Hex(nextBytes),
      publishedAt: row.published_at,
      sessionId: row.session_id,
    };
  });
}

export function transcriptDirectiveArchivesNeedMigration(
  database: DatabaseSync,
  start: ArchiveCursor,
): boolean {
  if (readArchiveRecoveryJournal(database, ARCHIVE_RECOVERY_KEY)) {
    return true;
  }
  let cursor = start;
  while (true) {
    const batch = listArchiveBatch(database, cursor);
    const last = batch.at(-1);
    if (!last) {
      return false;
    }
    if (batch.some((planned) => planned.changed)) {
      return true;
    }
    cursor = { generation: last.generation, sessionId: last.sessionId };
  }
}

export function transcriptDirectiveArchiveRecoveryPending(database: DatabaseSync): boolean {
  return readArchiveRecoveryJournal(database, ARCHIVE_RECOVERY_KEY) !== undefined;
}

function assertArchiveSourceUnchanged(database: DatabaseSync, planned: ArchiveRowPlan): boolean {
  const db = getNodeSqliteKysely<TranscriptArchiveMigrationDatabase>(database);
  const current = executeSqliteQueryTakeFirstSync(
    database,
    db
      .selectFrom("session_transcript_archives")
      .select(["archive_blob", "archive_name", "archive_sha256", "encoding"])
      .where("session_id", "=", planned.sessionId)
      .where("generation", "=", planned.generation),
  );
  if (!current) {
    return false;
  }
  if (
    current.archive_name !== planned.archiveName ||
    current.archive_sha256 !== planned.archiveSha256 ||
    current.encoding !== planned.encoding ||
    !Buffer.from(current.archive_blob).equals(planned.bytes)
  ) {
    throw new Error(
      `Transcript archive source changed before migration commit for ${planned.sessionId}`,
    );
  }
  return true;
}

function rewriteArchiveRow(database: DatabaseSync, planned: ArchiveRowPlan): boolean {
  if (!assertArchiveSourceUnchanged(database, planned)) {
    return false;
  }
  if (!planned.changed) {
    return true;
  }
  const db = getNodeSqliteKysely<TranscriptArchiveMigrationDatabase>(database);
  const result = executeSqliteQuerySync(
    database,
    db
      .updateTable("session_transcript_archives")
      .set({
        archive_blob: planned.nextBytes,
        archive_sha256: planned.nextSha256,
        published_at: null,
      })
      .where("session_id", "=", planned.sessionId)
      .where("generation", "=", planned.generation)
      .where("archive_sha256", "=", planned.archiveSha256),
  );
  if (result.numAffectedRows !== 1n) {
    throw new Error(`Transcript archive changed before rewrite for ${planned.sessionId}`);
  }
  return true;
}

function repairPublishedArchiveFile(params: {
  archiveDirectory: string;
  planned: Pick<ArchiveRowPlan, "archiveName" | "nextBytes" | "nextSha256">;
}): boolean {
  const archiveDirectory = path.resolve(params.archiveDirectory);
  const archivePath = path.resolve(archiveDirectory, params.planned.archiveName);
  if (
    path.dirname(archivePath) !== archiveDirectory ||
    path.basename(archivePath) !== params.planned.archiveName
  ) {
    throw new Error(`Cannot migrate transcript archive outside ${archiveDirectory}`);
  }
  if (!fs.existsSync(archivePath)) {
    return false;
  }
  if (sha256Hex(fs.readFileSync(archivePath)) === params.planned.nextSha256) {
    return true;
  }
  assertAgentDatabaseMaintenanceAuthority();
  replaceFileAtomicSync({
    beforeRename: ({ tempPath }) => {
      const stagedHash = sha256Hex(fs.readFileSync(tempPath));
      if (stagedHash !== params.planned.nextSha256) {
        throw new Error(`Transcript archive staging verification failed for ${archivePath}`);
      }
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
  if (sha256Hex(fs.readFileSync(archivePath)) !== params.planned.nextSha256) {
    throw new Error(`Transcript archive verification failed for ${archivePath}`);
  }
  return true;
}

function finalizeArchiveCursor(params: {
  database: DatabaseSync;
  fileCurrent: boolean;
  planned: ArchiveRowPlan;
  recoveredPublishedAt?: number;
  writeCursor: (cursor: ArchiveCursor | { phase: "complete" }) => void;
}): void {
  const db = getNodeSqliteKysely<TranscriptArchiveMigrationDatabase>(params.database);
  const current = executeSqliteQueryTakeFirstSync(
    params.database,
    db
      .selectFrom("session_transcript_archives")
      .select(["archive_blob", "archive_sha256"])
      .where("session_id", "=", params.planned.sessionId)
      .where("generation", "=", params.planned.generation),
  );
  if (current) {
    if (
      current.archive_sha256 !== params.planned.nextSha256 ||
      !Buffer.from(current.archive_blob).equals(params.planned.nextBytes)
    ) {
      throw new Error(
        `Transcript archive changed before migration commit for ${params.planned.sessionId}`,
      );
    }
    const publishedAt = params.planned.publishedAt ?? params.recoveredPublishedAt;
    if (
      (params.planned.changed || params.recoveredPublishedAt !== undefined) &&
      publishedAt !== undefined &&
      params.fileCurrent
    ) {
      executeSqliteQuerySync(
        params.database,
        db
          .updateTable("session_transcript_archives")
          .set({ published_at: publishedAt })
          .where("session_id", "=", params.planned.sessionId)
          .where("generation", "=", params.planned.generation)
          .where("archive_sha256", "=", params.planned.nextSha256),
      );
    }
  }
  params.writeCursor({
    generation: params.planned.generation,
    sessionId: params.planned.sessionId,
  });
}

// Recover the committed pending batch independently of the caller's cursor.
// The media caller starts from the beginning on every run, and ordinary archive
// retention or insertion may change which rows fit in a listed page.
function recoverArchivePublication(params: {
  agentId: string;
  archiveDirectory: string;
  database: DatabaseSync;
  onArchive?: (archivePath: string) => void;
  pathname: string;
  recoveryKey: string;
}): string[] {
  const journal = readArchiveRecoveryJournal(params.database, params.recoveryKey);
  if (!journal) {
    return [];
  }
  const db = getNodeSqliteKysely<TranscriptArchiveMigrationDatabase>(params.database);
  const ready: ArchiveRecoveryRow[] = [];
  const unresolved: ArchiveRecoveryRow[] = [];
  const missingCopyExamples: string[] = [];
  for (const recorded of journal.rows) {
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
    if (sha256Hex(nextBytes) !== recorded.nextSha256) {
      throw new Error(`Canonical SQLite transcript archive is corrupt for ${recorded.sessionId}`);
    }
    const archivePath = path.resolve(params.archiveDirectory, row.archive_name);
    params.onArchive?.(archivePath);
    const fileCurrent = repairPublishedArchiveFile({
      archiveDirectory: params.archiveDirectory,
      planned: { archiveName: row.archive_name, nextBytes, nextSha256: recorded.nextSha256 },
    });
    if (fileCurrent) {
      ready.push(recorded);
    } else {
      unresolved.push(recorded);
      if (missingCopyExamples.length < MIGRATION_WARNING_EXAMPLE_LIMIT) {
        missingCopyExamples.push(`Missing canonical transcript archive copy: ${archivePath}`);
      }
    }
  }
  runSqliteImmediateTransactionSync(
    params.database,
    () => {
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
      if (unresolved.length > 0) {
        writeArchiveRecoveryJournal(params.database, params.agentId, params.recoveryKey, {
          rows: unresolved,
        });
      } else {
        clearArchiveRecoveryJournal(params.database, params.recoveryKey);
      }
      assertAgentDatabaseMaintenanceAuthority();
    },
    {
      busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
      databaseLabel: params.pathname,
      operationLabel: "historical-transcript-archive-recovery",
    },
  );
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

export function recoverPendingTranscriptArchivePublication(params: {
  agentId: string;
  database: DatabaseSync;
  pathname: string;
}): string[] {
  return recoverArchivePublication({
    ...params,
    archiveDirectory: resolveSqliteTranscriptArchiveDirectory({
      agentId: params.agentId,
      path: params.pathname,
    }),
    recoveryKey: ARCHIVE_RECOVERY_KEY,
  });
}

/** Repairs canonical blobs before their reconstructible files under maintenance authority. */
export async function migrateCanonicalTranscriptArchives(
  params: ArchiveMigrationOptions & {
    onArchive?: (archivePath: string) => void;
    transformContent: ArchiveContentTransform;
  },
): Promise<ArchiveMigrationResult> {
  let rewrittenArchives = 0;
  let cursor = params.start;
  const archiveDirectory = resolveSqliteTranscriptArchiveDirectory({
    agentId: params.agentId,
    path: params.pathname,
  });
  const recoveryWarnings = recoverArchivePublication({
    agentId: params.agentId,
    archiveDirectory,
    database: params.database,
    onArchive: params.onArchive,
    pathname: params.pathname,
    recoveryKey: ARCHIVE_RECOVERY_KEY,
  });
  let missingCopies = 0;
  const missingCopyExamples: string[] = [];
  while (true) {
    const batch = listArchiveBatch(params.database, cursor, params.transformContent);
    if (batch.length === 0) {
      runSqliteImmediateTransactionSync(
        params.database,
        () => {
          assertAgentDatabaseMaintenanceAuthority();
          params.writeCursor({ phase: "complete" });
          assertAgentDatabaseMaintenanceAuthority();
        },
        {
          databaseLabel: params.pathname,
          operationLabel: "historical-transcript-archive.complete",
        },
      );
      return {
        rewrittenArchives,
        warnings: [
          ...new Set([
            ...recoveryWarnings,
            ...(missingCopies > 0
              ? [
                  formatMigrationWarningSummary({
                    summary: `${params.pathname}: Missing ${missingCopies} canonical transcript archive file(s)`,
                    count: missingCopies,
                    detail:
                      "Canonical SQLite archive blobs remain retained. Migration completed without recreating the missing copies.",
                  }),
                  ...missingCopyExamples,
                ]
              : []),
          ]),
        ],
      };
    }
    for (const planned of batch) {
      params.onArchive?.(path.resolve(archiveDirectory, planned.archiveName));
    }
    // Persist the original publication timestamps with the rewritten blobs.
    // Until file repair and cursor commit finish, changed rows remain pending.
    const rowsPresent = runSqliteImmediateTransactionSync(
      params.database,
      () => {
        assertAgentDatabaseMaintenanceAuthority();
        const pending = new Map(
          (readArchiveRecoveryJournal(params.database, ARCHIVE_RECOVERY_KEY)?.rows ?? []).map(
            (row) => [archiveRecoveryRowKey(row), row],
          ),
        );
        const result = batch.map((planned) => rewriteArchiveRow(params.database, planned));
        let receiptsChanged = false;
        for (const [index, planned] of batch.entries()) {
          if (!result[index] || !planned.changed) {
            continue;
          }
          const key = archiveRecoveryRowKey(planned);
          const prior = pending.get(key);
          const publishedAt =
            planned.publishedAt ??
            (prior?.nextSha256 === planned.archiveSha256 ? prior.publishedAt : null);
          if (publishedAt === null) {
            continue;
          }
          pending.set(key, {
            generation: planned.generation,
            nextSha256: planned.nextSha256,
            publishedAt,
            sessionId: planned.sessionId,
          });
          receiptsChanged = true;
        }
        if (receiptsChanged) {
          writeArchiveRecoveryJournal(params.database, params.agentId, ARCHIVE_RECOVERY_KEY, {
            rows: [...pending.values()],
          });
        }
        assertAgentDatabaseMaintenanceAuthority();
        return result;
      },
      {
        busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: params.pathname,
        operationLabel: "historical-transcript-archive-directives",
      },
    );
    // Published files never point at rolled-back blobs: rewritten rows are
    // committed as pending before an atomic replacement can touch a file.
    const filesCurrent = batch.map((planned, index) => {
      const archivePath = path.resolve(archiveDirectory, planned.archiveName);
      const fileCurrent = rowsPresent[index]
        ? repairPublishedArchiveFile({ archiveDirectory, planned })
        : false;
      if (rowsPresent[index] && !fileCurrent) {
        missingCopies += 1;
        if (missingCopyExamples.length < MIGRATION_WARNING_EXAMPLE_LIMIT) {
          missingCopyExamples.push(`Missing canonical transcript archive copy: ${archivePath}`);
        }
      }
      return fileCurrent;
    });
    // Cursor progress and verified timestamp restoration are atomic with
    // removal of only the settled receipts. Missing files keep their receipts.
    runSqliteImmediateTransactionSync(
      params.database,
      () => {
        assertAgentDatabaseMaintenanceAuthority();
        const journal = readArchiveRecoveryJournal(params.database, ARCHIVE_RECOVERY_KEY);
        const pending = new Map(
          (journal?.rows ?? []).map((row) => [archiveRecoveryRowKey(row), row]),
        );
        for (const [index, planned] of batch.entries()) {
          const key = archiveRecoveryRowKey(planned);
          const recorded = pending.get(key);
          const fileCurrent = filesCurrent[index] === true;
          finalizeArchiveCursor({
            database: params.database,
            fileCurrent,
            planned,
            recoveredPublishedAt:
              recorded?.nextSha256 === planned.nextSha256 ? recorded.publishedAt : undefined,
            writeCursor: params.writeCursor,
          });
          if (!rowsPresent[index] || (fileCurrent && recorded?.nextSha256 === planned.nextSha256)) {
            pending.delete(key);
          }
        }
        if (pending.size > 0) {
          writeArchiveRecoveryJournal(params.database, params.agentId, ARCHIVE_RECOVERY_KEY, {
            rows: [...pending.values()],
          });
        } else if (journal) {
          clearArchiveRecoveryJournal(params.database, ARCHIVE_RECOVERY_KEY);
        }
        assertAgentDatabaseMaintenanceAuthority();
      },
      {
        busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: params.pathname,
        operationLabel: "historical-transcript-archive-cursor",
      },
    );
    rewrittenArchives += batch.filter(
      (planned, index) => planned.changed && rowsPresent[index],
    ).length;
    const last = batch.at(-1)!;
    cursor = { generation: last.generation, sessionId: last.sessionId };
    // Archive planning and file publication are synchronous. Give the lease
    // heartbeat a scheduling point before the next bounded batch begins.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

export function migrateTranscriptDirectiveArchives(
  params: ArchiveMigrationOptions,
): Promise<ArchiveMigrationResult> {
  return migrateCanonicalTranscriptArchives({
    ...params,
    transformContent: transformArchiveContent,
  });
}
