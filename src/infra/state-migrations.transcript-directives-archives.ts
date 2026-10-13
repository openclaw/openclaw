import type { DatabaseSync } from "node:sqlite";
import {
  decodeSessionArchiveBytes,
  encodeSessionArchiveContent,
  SESSION_ARCHIVE_ZSTD_SUFFIX,
} from "../config/sessions/archive-compression.js";
import { resolveSqliteTranscriptArchiveDirectory } from "../config/sessions/session-accessor.sqlite-scope.js";
import {
  assertAgentDatabaseMaintenanceAuthority,
  renewAgentDatabaseMaintenanceAuthorityIfPresent,
} from "../state/openclaw-agent-db-lease.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import { SESSION_TRANSCRIPT_ARCHIVES_TABLE } from "../state/openclaw-agent-session-transcript-archive-schema.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../state/openclaw-state-db.js";
import { sha256Hex } from "./crypto-digest.js";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import {
  formatMigrationWarningSummary,
  MIGRATION_WARNING_EXAMPLE_LIMIT,
} from "./migration-warning-summary.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { withPreparedSqliteSnapshot } from "./sqlite-readonly-location-cleanup.js";
import { resolveSqliteInspectionSignal } from "./sqlite-readonly-worker.js";
import { prepareSqliteReadOnlyLocation } from "./sqlite-snapshot-source.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import type { PreparedAgentDatabaseMigrationDiscovery } from "./state-migrations.media-persistence-targets.js";
import { transformMediaArchiveContent } from "./state-migrations.media-persistence-transform.js";
import {
  clearTranscriptArchiveRecoveryJournal,
  readTranscriptArchiveRecoveryJournal,
  recoverTranscriptArchivePublication,
  repairPublishedTranscriptArchive,
  TRANSCRIPT_ARCHIVE_MIGRATION_BATCH_SIZE,
  transcriptArchiveFingerprint,
  transcriptArchivePathFor,
  transcriptArchiveRecoveryRowKey,
  writeTranscriptArchiveRecoveryJournal,
} from "./state-migrations.transcript-archive-publication.js";
import {
  parseDirectiveMigrationTranscriptEvent,
  transformHistoricalTranscriptEvent,
} from "./state-migrations.transcript-directives-transform.js";

export const TRANSCRIPT_DIRECTIVE_MIGRATION_BATCH_SIZE = TRANSCRIPT_ARCHIVE_MIGRATION_BATCH_SIZE;
export const MEDIA_ARCHIVE_VERIFICATION_KEY = "media-transcript-archive-verification-v1";
export { recoverPendingTranscriptArchivePublication } from "./state-migrations.transcript-archive-publication.js";

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
  signal?: AbortSignal;
  verification?: { key: string; prepared?: ReadonlySet<string>; collect?: Set<string> };
  verifyOnly?: boolean;
  writeCursor?: (cursor: ArchiveCursor | { phase: "complete" }) => void;
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
  fingerprint?: string;
};

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

export function encodeArchiveContent(
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

function hasArchiveTable(database: DatabaseSync): boolean {
  // The archive table was added lazily at agent schema v17, so valid v17 databases may omit it.
  return Boolean(
    database
      .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
      .get(SESSION_TRANSCRIPT_ARCHIVES_TABLE),
  );
}

function listArchiveBatch(
  database: DatabaseSync,
  cursor: ArchiveCursor | undefined,
  transformContent: ArchiveContentTransform = transformArchiveContent,
  options?: {
    archiveDirectory: string;
    signal?: AbortSignal;
    verified?: ReadonlySet<string>;
  },
): ArchiveRowPlan[] {
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
  if (cursor) {
    // Empty key parts still seek the composite key; only the first page has no cursor.
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
    const archivePath = options
      ? transcriptArchivePathFor(options.archiveDirectory, row.archive_name)
      : row.archive_name;
    try {
      options?.signal?.throwIfAborted();
      const encoding = readArchiveEncoding(row.encoding, owner);
      const bytes = Buffer.from(row.archive_blob);
      if (sha256Hex(bytes) !== row.archive_sha256) {
        throw new Error("Canonical SQLite transcript archive is corrupt");
      }
      const fingerprint = options
        ? transcriptArchiveFingerprint(archivePath, row.archive_sha256, encoding)
        : undefined;
      const verified = fingerprint !== undefined && options?.verified?.has(fingerprint) === true;
      const transformed = verified
        ? undefined
        : transformContent(decodeSessionArchiveBytes(bytes, encoding === "zstd"), owner);
      options?.signal?.throwIfAborted();
      const nextBytes = transformed?.changed
        ? encodeArchiveContent(transformed.content, encoding, owner)
        : bytes;
      return {
        archiveName: row.archive_name,
        archiveSha256: row.archive_sha256,
        bytes,
        changed: transformed?.changed === true,
        encoding,
        generation: row.generation,
        nextBytes,
        nextSha256: sha256Hex(nextBytes),
        publishedAt: row.published_at,
        sessionId: row.session_id,
        fingerprint: verified ? fingerprint : undefined,
      };
    } catch (error) {
      if (options?.signal?.aborted && error === options.signal.reason) {
        throw error;
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed migrating transcript archive ${archivePath} (${owner}): ${detail}`, {
        cause: error,
      });
    }
  });
}

export async function transcriptDirectiveArchivesNeedMigration(
  database: DatabaseSync,
  start: ArchiveCursor,
): Promise<boolean> {
  const signal = resolveSqliteInspectionSignal();
  signal?.throwIfAborted();
  if (!hasArchiveTable(database)) {
    return false;
  }
  if (readTranscriptArchiveRecoveryJournal(database)) {
    return true;
  }
  let cursor: ArchiveCursor | undefined = start.sessionId || start.generation ? start : undefined;
  while (true) {
    signal?.throwIfAborted();
    const batch = listArchiveBatch(database, cursor);
    const last = batch.at(-1);
    if (!last) {
      return false;
    }
    if (batch.some((planned) => planned.changed)) {
      return true;
    }
    cursor = { generation: last.generation, sessionId: last.sessionId };
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

export function transcriptDirectiveArchiveRecoveryPending(database: DatabaseSync): boolean {
  return readTranscriptArchiveRecoveryJournal(database) !== undefined;
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

function finalizeArchiveCursor(params: {
  database: DatabaseSync;
  fileCurrent: boolean;
  planned: ArchiveRowPlan;
  recoveredPublishedAt?: number;
  writeCursor?: (cursor: ArchiveCursor | { phase: "complete" }) => void;
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
  params.writeCursor?.({
    generation: params.planned.generation,
    sessionId: params.planned.sessionId,
  });
}

/** Repairs canonical blobs before their reconstructible files under maintenance authority. */
export async function migrateCanonicalTranscriptArchives(
  params: ArchiveMigrationOptions & {
    onArchive?: (archivePath: string) => void;
    transformContent: ArchiveContentTransform;
  },
): Promise<ArchiveMigrationResult> {
  const signal = resolveSqliteInspectionSignal(params.signal);
  signal?.throwIfAborted();
  let rewrittenArchives = 0;
  let cursor: ArchiveCursor | undefined =
    params.start.sessionId || params.start.generation ? params.start : undefined;
  const archivesPresent = hasArchiveTable(params.database);
  const db = getNodeSqliteKysely<TranscriptArchiveMigrationDatabase>(params.database);
  const verificationKey = params.verification?.key;
  const previousVerification = verificationKey
    ? (executeSqliteQueryTakeFirstSync(
        params.database,
        db.selectFrom("schema_meta").select("app_version").where("meta_key", "=", verificationKey),
      )?.app_version ?? "")
    : "";
  const verified = new Set([
    ...previousVerification.split("\n"),
    ...(params.verification?.prepared ?? []),
  ]);
  const observed = new Set<string>();
  const archiveDirectory = resolveSqliteTranscriptArchiveDirectory({
    agentId: params.agentId,
    path: params.pathname,
  });
  const recoveryWarnings = params.verifyOnly
    ? []
    : await recoverTranscriptArchivePublication({
        agentId: params.agentId,
        archiveDirectory,
        database: params.database,
        onArchive: params.onArchive,
        pathname: params.pathname,
        signal,
      });
  const write = <T>(operationLabel: string, operation: () => T): T =>
    runSqliteImmediateTransactionSync(
      params.database,
      () => {
        signal?.throwIfAborted();
        assertAgentDatabaseMaintenanceAuthority();
        const result = operation();
        signal?.throwIfAborted();
        assertAgentDatabaseMaintenanceAuthority();
        return result;
      },
      {
        busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: params.pathname,
        operationLabel,
      },
    );
  const checkpoint = params.verifyOnly ? undefined : params.writeCursor;
  let missingCopies = 0;
  const missingCopyExamples: string[] = [];
  while (true) {
    signal?.throwIfAborted();
    if (!params.verifyOnly) {
      renewAgentDatabaseMaintenanceAuthorityIfPresent();
    }
    const batch = archivesPresent
      ? listArchiveBatch(params.database, cursor, params.transformContent, {
          archiveDirectory,
          signal,
          verified,
        })
      : [];
    if (batch.length === 0) {
      if (checkpoint) {
        write("historical-transcript-archive.complete", () => checkpoint({ phase: "complete" }));
      }
      const verificationReceipt = [...observed].toSorted().join("\n");
      if (verificationKey && !params.verifyOnly && verificationReceipt !== previousVerification) {
        write("transcript-archive-verification.record", () => {
          const now = Date.now();
          executeSqliteQuerySync(
            params.database,
            db
              .insertInto("schema_meta")
              .values({
                meta_key: verificationKey,
                role: "agent",
                agent_id: params.agentId,
                schema_version: 1,
                app_version: verificationReceipt,
                created_at: now,
                updated_at: now,
              })
              .onConflict((conflict) =>
                conflict
                  .column("meta_key")
                  .doUpdateSet({ app_version: verificationReceipt, updated_at: now }),
              ),
          );
        });
      }
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
    let current = batch[0]!;
    try {
      for (const planned of batch) {
        current = planned;
        params.onArchive?.(transcriptArchivePathFor(archiveDirectory, planned.archiveName));
      }
      signal?.throwIfAborted();
      // Persist the original publication timestamps with the rewritten blobs.
      // Until file repair and cursor commit finish, changed rows remain pending.
      const needsRewrite = batch.some((planned) => planned.changed);
      const rowsPresent =
        params.verifyOnly || !needsRewrite
          ? batch.map((planned) => {
              current = planned;
              return !planned.changed && assertArchiveSourceUnchanged(params.database, planned);
            })
          : write("historical-transcript-archive-directives", () => {
              const pending = new Map(
                (readTranscriptArchiveRecoveryJournal(params.database)?.rows ?? []).map((row) => [
                  transcriptArchiveRecoveryRowKey(row),
                  row,
                ]),
              );
              const result = batch.map((planned) => {
                current = planned;
                return rewriteArchiveRow(params.database, planned);
              });
              let receiptsChanged = false;
              for (const [index, planned] of batch.entries()) {
                if (!result[index] || !planned.changed) {
                  continue;
                }
                const key = transcriptArchiveRecoveryRowKey(planned);
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
                writeTranscriptArchiveRecoveryJournal(params.database, params.agentId, [
                  ...pending.values(),
                ]);
              }
              return result;
            });
      // Published files never point at rolled-back blobs: rewritten rows are
      // committed as pending before an atomic replacement can touch a file.
      const filesCurrent = batch.map((planned, index) => {
        current = planned;
        const archivePath = transcriptArchivePathFor(archiveDirectory, planned.archiveName);
        let fileCurrent: boolean;
        try {
          fileCurrent = rowsPresent[index]
            ? repairPublishedTranscriptArchive({
                archiveDirectory,
                planned,
                signal,
                verifyOnly: params.verifyOnly,
              })
            : false;
        } catch (error) {
          if (signal?.aborted && error === signal.reason) {
            throw error;
          }
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(`Failed publishing transcript archive ${archivePath}: ${detail}`, {
            cause: error,
          });
        }
        if (rowsPresent[index] && !planned.changed) {
          assertArchiveSourceUnchanged(params.database, planned);
        }
        if (rowsPresent[index] && !fileCurrent) {
          missingCopies += 1;
          if (missingCopyExamples.length < MIGRATION_WARNING_EXAMPLE_LIMIT) {
            missingCopyExamples.push(`Missing canonical transcript archive copy: ${archivePath}`);
          }
        }
        if (rowsPresent[index] && planned.fingerprint) {
          observed.add(planned.fingerprint);
          params.verification?.collect?.add(planned.fingerprint);
        }
        return fileCurrent;
      });
      // Cursor progress and verified timestamp restoration are atomic with
      // removal of only the settled receipts. Missing files keep their receipts.
      if (!params.verifyOnly && (needsRewrite || checkpoint)) {
        write("historical-transcript-archive-cursor", () => {
          const journal = readTranscriptArchiveRecoveryJournal(params.database);
          const pending = new Map(
            (journal?.rows ?? []).map((row) => [transcriptArchiveRecoveryRowKey(row), row]),
          );
          for (const [index, planned] of batch.entries()) {
            current = planned;
            const key = transcriptArchiveRecoveryRowKey(planned);
            const recorded = pending.get(key);
            const fileCurrent = filesCurrent[index] === true;
            finalizeArchiveCursor({
              database: params.database,
              fileCurrent,
              planned,
              recoveredPublishedAt:
                recorded?.nextSha256 === planned.nextSha256 ? recorded.publishedAt : undefined,
              writeCursor: checkpoint,
            });
            if (
              !rowsPresent[index] ||
              (fileCurrent && recorded?.nextSha256 === planned.nextSha256)
            ) {
              pending.delete(key);
            }
          }
          if (pending.size > 0) {
            writeTranscriptArchiveRecoveryJournal(params.database, params.agentId, [
              ...pending.values(),
            ]);
          } else if (journal) {
            clearTranscriptArchiveRecoveryJournal(params.database);
          }
        });
      }
      rewrittenArchives += batch.filter(
        (planned, index) => planned.changed && rowsPresent[index],
      ).length;
      const last = batch.at(-1)!;
      cursor = { generation: last.generation, sessionId: last.sessionId };
    } catch (error) {
      if (signal?.aborted && error === signal.reason) {
        throw error;
      }
      throw new Error(
        `Transcript archive migration failed for ${params.pathname} at ${current.sessionId}:${current.generation}: ${String(error)}`,
        { cause: error },
      );
    }
    // Archive planning and file publication are synchronous. Give the lease
    // heartbeat a scheduling point before the next bounded batch begins.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    signal?.throwIfAborted();
  }
}

/** Read and transform retained archives before Doctor stops the managed writer. */
export async function prepareCanonicalTranscriptArchiveMigrations(
  discovery: PreparedAgentDatabaseMigrationDiscovery,
): Promise<void> {
  const prepared = new Set<string>();
  discovery.preparedTranscriptArchives = prepared;
  for (const target of discovery.discovery.targets) {
    const snapshot = await prepareSqliteReadOnlyLocation(target.realPath, {
      preserveSourceArtifacts: true,
      allowLiveOwner: true,
    });
    await withPreparedSqliteSnapshot(snapshot, async (location) => {
      const database = openNodeSqliteDatabase(location, { readOnly: true });
      try {
        await migrateCanonicalTranscriptArchives({
          agentId: target.agentId,
          pathname: target.path,
          database,
          start: { generation: "", sessionId: "" },
          verifyOnly: true,
          verification: { key: MEDIA_ARCHIVE_VERIFICATION_KEY, collect: prepared },
          transformContent: transformMediaArchiveContent,
        });
      } finally {
        clearNodeSqliteKyselyCacheForDatabase(database);
        database.close();
      }
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
