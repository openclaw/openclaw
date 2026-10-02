import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { replaceFileAtomicSync } from "@openclaw/fs-safe/atomic";
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
import { VERSION } from "../version.js";
import { sha256Hex } from "./crypto-digest.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  clearNodeSqliteKyselyCacheForDatabase,
} from "./kysely-sync.js";
import {
  formatMigrationWarningSummary,
  MIGRATION_WARNING_EXAMPLE_LIMIT,
} from "./migration-warning-summary.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { withPreparedSqliteSnapshot } from "./sqlite-readonly-location-cleanup.js";
import { prepareSqliteReadOnlyLocation } from "./sqlite-snapshot-source.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import type { PreparedAgentDatabaseMigrationDiscovery } from "./state-migrations.media-persistence-targets.js";
import { transformMediaArchiveContent } from "./state-migrations.media-persistence-transform.js";
import {
  parseDirectiveMigrationTranscriptEvent,
  transformHistoricalTranscriptEvent,
} from "./state-migrations.transcript-directives-transform.js";

export const TRANSCRIPT_DIRECTIVE_MIGRATION_BATCH_SIZE = 32;
export const MEDIA_ARCHIVE_VERIFICATION_KEY = "media-transcript-archive-verification-v1";

type TranscriptArchiveMigrationDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "session_transcript_archives" | "schema_meta"
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
  writeCursor?: (cursor: ArchiveCursor | { phase: "complete" }) => void;
  verification?: { key: string; prepared?: ReadonlySet<string>; collect?: Set<string> };
  verifyOnly?: boolean;
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

function archivePathFor(archiveDirectory: string, archiveName: string): string {
  const archivePath = path.resolve(archiveDirectory, archiveName);
  if (
    path.dirname(archivePath) !== path.resolve(archiveDirectory) ||
    path.basename(archivePath) !== archiveName
  ) {
    throw new Error(`Cannot migrate transcript archive outside ${archiveDirectory}`);
  }
  return archivePath;
}

function archiveFingerprint(
  archivePath: string,
  sha256: string,
  encoding: string,
): string | undefined {
  let stat: fs.BigIntStats | undefined;
  try {
    stat = fs.statSync(archivePath, { bigint: true, throwIfNoEntry: false });
  } catch {
    // Unobservable attributes cannot certify a copy; its per-row repair still owns IO errors.
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
  cursor: ArchiveCursor,
  transformContent: ArchiveContentTransform = transformArchiveContent,
  verification?: {
    archiveDirectory: string;
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
    const archivePath = verification
      ? archivePathFor(verification.archiveDirectory, row.archive_name)
      : undefined;
    const fingerprint = archivePath
      ? archiveFingerprint(archivePath, row.archive_sha256, encoding)
      : undefined;
    const verified = fingerprint !== undefined && verification?.verified?.has(fingerprint) === true;
    const transformed = verified
      ? undefined
      : transformContent(decodeSessionArchiveBytes(bytes, encoding === "zstd"), owner);
    const nextBytes = transformed?.changed
      ? encodeArchiveContent(transformed.content, encoding, owner)
      : bytes;
    const nextSha256 = sha256Hex(nextBytes);
    return {
      archiveName: row.archive_name,
      archiveSha256: row.archive_sha256,
      bytes,
      changed: transformed?.changed === true,
      encoding,
      generation: row.generation,
      nextBytes,
      nextSha256,
      publishedAt: row.published_at,
      sessionId: row.session_id,
      fingerprint: verified ? fingerprint : undefined,
    };
  });
}

export function transcriptDirectiveArchivesNeedMigration(
  database: DatabaseSync,
  start: ArchiveCursor,
): boolean {
  if (!hasArchiveTable(database)) {
    return false;
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

function writeArchiveRow(
  database: DatabaseSync,
  planned: ArchiveRowPlan,
  publish = false,
): boolean {
  if (!assertArchiveSourceUnchanged(database, planned)) {
    return false;
  }
  const db = getNodeSqliteKysely<TranscriptArchiveMigrationDatabase>(database);
  const result = executeSqliteQuerySync(
    database,
    db
      .updateTable("session_transcript_archives")
      .set(
        publish
          ? { published_at: planned.publishedAt }
          : {
              archive_blob: planned.nextBytes,
              archive_sha256: planned.nextSha256,
              published_at: null,
            },
      )
      .where("session_id", "=", planned.sessionId)
      .where("generation", "=", planned.generation)
      .where("archive_sha256", "=", planned.archiveSha256),
  );
  if (result.numAffectedRows !== 1n) {
    throw new Error(`Transcript archive changed before rewrite for ${planned.sessionId}`);
  }
  planned.bytes = planned.nextBytes;
  planned.archiveSha256 = planned.nextSha256;
  return true;
}

function repairPublishedArchiveFile(params: {
  archiveDirectory: string;
  planned: ArchiveRowPlan;
  verifyOnly?: boolean;
}): boolean {
  const archiveDirectory = path.resolve(params.archiveDirectory);
  const archivePath = archivePathFor(archiveDirectory, params.planned.archiveName);
  const fingerprint = () =>
    archiveFingerprint(archivePath, params.planned.nextSha256, params.planned.encoding);
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
  const published = fingerprint();
  if (sha256Hex(fs.readFileSync(archivePath)) !== params.planned.nextSha256) {
    throw new Error(`Transcript archive verification failed for ${archivePath}`);
  }
  params.planned.fingerprint = fingerprint() === published ? published : undefined;
  return true;
}

/** Repairs canonical blobs before their reconstructible files under maintenance authority. */
export async function migrateCanonicalTranscriptArchives(
  params: ArchiveMigrationOptions & {
    onArchive?: (archivePath: string) => void;
    transformContent: ArchiveContentTransform;
  },
): Promise<ArchiveMigrationResult> {
  let rewrittenArchives = 0;
  let missingCopies = 0;
  const missingCopyExamples: string[] = [];
  const archivesPresent = hasArchiveTable(params.database);
  const db = getNodeSqliteKysely<TranscriptArchiveMigrationDatabase>(params.database);
  const key = params.verification?.key;
  const previous = key
    ? (executeSqliteQueryTakeFirstSync(
        params.database,
        db.selectFrom("schema_meta").select("app_version").where("meta_key", "=", key),
      )?.app_version ?? "")
    : "";
  const verified = new Set([...previous.split("\n"), ...(params.verification?.prepared ?? [])]);
  const observed = new Set<string>();
  let cursor = params.start;
  const archiveDirectory = resolveSqliteTranscriptArchiveDirectory({
    agentId: params.agentId,
    path: params.pathname,
  });
  const write = <T>(operationLabel: string, operation: () => T): T =>
    runSqliteImmediateTransactionSync(
      params.database,
      () => {
        assertAgentDatabaseMaintenanceAuthority();
        const result = operation();
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
  while (true) {
    const batch = archivesPresent
      ? listArchiveBatch(params.database, cursor, params.transformContent, {
          archiveDirectory,
          verified,
        })
      : [];
    if (batch.length === 0) {
      if (checkpoint) {
        write("historical-transcript-archive.complete", () => checkpoint({ phase: "complete" }));
      }
      const receipt = [...observed].toSorted().join("\n");
      if (key && !params.verifyOnly && receipt !== previous) {
        write("transcript-archive-verification.record", () => {
          const now = Date.now();
          executeSqliteQuerySync(
            params.database,
            db
              .insertInto("schema_meta")
              .values({
                meta_key: key,
                role: "agent",
                agent_id: params.agentId,
                schema_version: 1,
                app_version: receipt,
                created_at: now,
                updated_at: now,
              })
              .onConflict((conflict) =>
                conflict.column("meta_key").doUpdateSet({ app_version: receipt, updated_at: now }),
              ),
          );
        });
      }
      return {
        rewrittenArchives,
        warnings:
          missingCopies > 0
            ? [
                formatMigrationWarningSummary({
                  summary: `${params.pathname}: Missing ${missingCopies} canonical transcript archive file(s)`,
                  count: missingCopies,
                  detail:
                    "Canonical SQLite archive blobs remain retained. Migration completed without recreating the missing copies.",
                }),
                ...missingCopyExamples,
              ]
            : [],
      };
    }
    for (const planned of batch) {
      cursor = { generation: planned.generation, sessionId: planned.sessionId };
      if (params.verifyOnly && planned.changed) {
        continue;
      }
      const archivePath = path.resolve(archiveDirectory, planned.archiveName);
      params.onArchive?.(archivePath);
      const rowPresent = planned.changed
        ? write("historical-transcript-archive-directives", () =>
            writeArchiveRow(params.database, planned),
          )
        : assertArchiveSourceUnchanged(params.database, planned);
      const fileCurrent = rowPresent
        ? repairPublishedArchiveFile({ archiveDirectory, planned, verifyOnly: params.verifyOnly })
        : false;
      if (rowPresent) {
        assertArchiveSourceUnchanged(params.database, planned);
      }
      if (rowPresent && !fileCurrent) {
        missingCopies += 1;
        if (missingCopyExamples.length < MIGRATION_WARNING_EXAMPLE_LIMIT) {
          missingCopyExamples.push(`Missing canonical transcript archive copy: ${archivePath}`);
        }
      }
      if (rowPresent && planned.changed && fileCurrent && planned.publishedAt !== null) {
        write("historical-transcript-archive-publication", () =>
          writeArchiveRow(params.database, planned, true),
        );
      }
      if (rowPresent && planned.fingerprint) {
        observed.add(planned.fingerprint);
        params.verification?.collect?.add(planned.fingerprint);
      }
      rewrittenArchives += planned.changed && rowPresent ? 1 : 0;
    }
    if (checkpoint) {
      write("historical-transcript-archive-cursor", () => checkpoint(cursor));
    }
    // Archive planning and file publication are synchronous. Give the lease
    // heartbeat a scheduling point before the next bounded batch begins.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
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
