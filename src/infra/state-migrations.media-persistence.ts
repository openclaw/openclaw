import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import {
  decodeSessionArchiveBytes,
  encodeSessionArchiveContent,
  readSessionArchiveContentSync,
  SESSION_ARCHIVE_ZSTD_SUFFIX,
} from "../config/sessions/archive-compression.js";
import { resolveSqliteTranscriptArchiveDirectory } from "../config/sessions/session-accessor.sqlite-scope.js";
import { reconcileSessionTranscriptIndexInTransaction } from "../config/sessions/session-transcript-index.js";
import {
  AGENT_MEDIA_SCHEMA_VERSION,
  AGENT_STORAGE_SCHEMA_VERSION,
} from "../state/openclaw-agent-db-contract.js";
import {
  assertAgentDatabaseMaintenanceAuthority,
  invalidateOpenClawAgentDatabaseIntegrityBeforeMutation,
  renewAgentDatabaseMaintenanceAuthorityIfPresent,
} from "../state/openclaw-agent-db-lease.js";
import { assertOpenClawAgentDatabaseOwner } from "../state/openclaw-agent-db-maintenance.js";
import {
  registerOpenClawAgentDatabase,
  unregisterOpenClawAgentDatabase,
} from "../state/openclaw-agent-db-registry.js";
import { assertOpenClawAgentSchemaContains } from "../state/openclaw-agent-db-schema-helpers.js";
import {
  ensureOpenClawAgentDatabaseSchema,
  migrateOpenClawAgentDatabaseToMediaPrerequisiteSchema,
} from "../state/openclaw-agent-db-schema.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  withAgentDatabaseMaintenanceLease,
  type OpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { withLegacySessionParticipantsSchema } from "../state/openclaw-agent-participants-migration.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "../state/openclaw-agent-schema.js";
import { withLegacyAgentStorageSchema } from "../state/openclaw-agent-storage-schema.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../state/openclaw-state-db.js";
import { VERSION } from "../version.js";
import { formatErrorMessage } from "./errors.js";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  clearNodeSqliteKyselyCacheForDatabase,
  enableNodeSqliteKyselyStatementCache,
} from "./kysely-sync.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { replaceFileAtomicSync } from "./replace-file.js";
import { repairCanonicalSqliteIndexes } from "./sqlite-index-schema.js";
import { configureSqliteMaintenanceCache } from "./sqlite-maintenance-cache.js";
import {
  runSqliteDeferredTransactionSync,
  runSqliteImmediateTransactionSync,
} from "./sqlite-transaction.js";
import { readSqliteUserVersion } from "./sqlite-user-version.js";
import { createSqliteWalReclamationResult } from "./sqlite-wal-reclamation.js";
import { recoverMisplacedAgentDatabaseCopies } from "./state-migrations.agent-owner-recovery.js";
import {
  mediaSourceDriftMessage,
  readMediaSourceVersion,
  scanTranscriptRows,
  scanTrajectoryRows,
} from "./state-migrations.media-persistence-database.js";
import {
  listTranscriptArchives,
  prepareAgentDatabaseMigrationDiscovery,
  agentDatabaseMigrationAdvisory,
  resolveAgentDatabaseMigrationTargets,
  type AgentDatabaseMigrationTarget,
  type PreparedAgentDatabaseMigrationDiscovery,
} from "./state-migrations.media-persistence-targets.js";
import {
  assertEventIdentitiesUnchanged,
  parseArchiveContent,
  transformMediaArchiveContent,
} from "./state-migrations.media-persistence-transform.js";
import { migrateCanonicalTranscriptArchives } from "./state-migrations.transcript-directives-archives.js";
import type { MigrationMessages } from "./state-migrations.types.js";

const PREVIOUS_MEDIA_SCHEMA_VERSION = AGENT_MEDIA_SCHEMA_VERSION - 1;
const ARCHIVE_TEMP_MARKER = ".media-retirement";

type MediaMigrationDatabase = Pick<OpenClawAgentKyselyDatabase, "schema_meta">;

type ArchiveSourceSnapshot = {
  dev: number;
  ino: number;
  mtimeMs: number;
  sha256: string;
  size: number;
};

function createMigrationDatabaseHandle(
  database: DatabaseSync,
  agentId: string,
  pathname: string,
): OpenClawAgentDatabase {
  return {
    agentId,
    db: database,
    path: pathname,
    walMaintenance: {
      checkpoint: () => false,
      close: () => false,
      reclaimFreePages: createSqliteWalReclamationResult,
    },
  };
}

function refreshAgentDatabasePlannerStatistics(database: DatabaseSync): void {
  // Doctor owns a stopped-writer maintenance window here. Explicitly analyze every
  // table because the supported pre-3.46 SQLite floor lacks optimize's all-table bit.
  database.exec("PRAGMA analysis_limit=1000; ANALYZE main;");
}

async function migrateAgentDatabase(params: {
  agentId: string;
  canonicalArchivePaths: Set<string>;
  beforeTransaction?: () => void;
  pathname: string;
}) {
  invalidateOpenClawAgentDatabaseIntegrityBeforeMutation(params.pathname);
  const database = openNodeSqliteDatabase(params.pathname);
  const migrateArchives = () =>
    migrateCanonicalTranscriptArchives({
      agentId: params.agentId,
      database,
      pathname: params.pathname,
      start: { generation: "", sessionId: "" },
      // Imports and restores can introduce legacy media after any successful pass.
      // Reuse archive repair without persisting the directive migration's cursor.
      writeCursor: () => {},
      onArchive: (archivePath) => params.canonicalArchivePaths.add(archivePath),
      transformContent: transformMediaArchiveContent,
    });
  try {
    configureSqliteMaintenanceCache(database);
    database.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
    enableNodeSqliteKyselyStatementCache(database);
    let metadata = assertOpenClawAgentDatabaseOwner(database, {
      agentId: params.agentId,
      pathname: params.pathname,
    });
    let userVersion = readSqliteUserVersion(database);
    const initialVersion = userVersion;
    if (userVersion <= PREVIOUS_MEDIA_SCHEMA_VERSION) {
      migrateOpenClawAgentDatabaseToMediaPrerequisiteSchema(database, {
        agentId: params.agentId,
        path: params.pathname,
      });
      metadata = assertOpenClawAgentDatabaseOwner(database, {
        agentId: params.agentId,
        pathname: params.pathname,
      });
      userVersion = readSqliteUserVersion(database);
    }
    if (metadata.schemaVersion !== userVersion) {
      throw new Error(
        `${params.pathname} metadata schema version ${metadata.schemaVersion ?? "invalid"} does not match ${userVersion}`,
      );
    }
    if (userVersion >= AGENT_MEDIA_SCHEMA_VERSION) {
      // The canonical owner admits supported versions and converges additive schema;
      // media must not enumerate later schema revisions independently.
      ensureOpenClawAgentDatabaseSchema(database, {
        agentId: params.agentId,
        path: params.pathname,
      });
      userVersion = readSqliteUserVersion(database);
    }
    const mediaSchemaUpgrade = userVersion === PREVIOUS_MEDIA_SCHEMA_VERSION;
    const assertMediaSchemaMigration = () => {
      if (!mediaSchemaUpgrade) {
        return;
      }
      assertAgentDatabaseMaintenanceAuthority();
      getOpenClawDatabaseMaintenanceScope()?.assertAgentSchemaMigration({
        agentId: params.agentId,
        path: params.pathname,
        foundVersion: userVersion,
        supportedVersion: AGENT_MEDIA_SCHEMA_VERSION,
      });
    };
    assertMediaSchemaMigration();
    const schemaMode = userVersion < OPENCLAW_AGENT_SCHEMA_VERSION ? "legacy" : "current";
    const schemaSql =
      schemaMode === "legacy"
        ? withLegacySessionParticipantsSchema(
            withLegacyAgentStorageSchema(OPENCLAW_AGENT_SCHEMA_SQL),
          )
        : OPENCLAW_AGENT_SCHEMA_SQL;
    // Remove after 2026-10-12: drop the v15-to-v16 media cutover once schema 16 is the support floor.
    if (userVersion === PREVIOUS_MEDIA_SCHEMA_VERSION) {
      repairCanonicalSqliteIndexes(database, params.pathname, schemaSql, {
        validateAfterRepair: () =>
          assertOpenClawAgentSchemaContains(database, params.pathname, schemaSql, schemaMode),
      });
    }
    assertOpenClawAgentSchemaContains(database, params.pathname, schemaSql, schemaMode);
    const legacyTextStorage = userVersion < AGENT_STORAGE_SCHEMA_VERSION;
    if (!mediaSchemaUpgrade) {
      const needsRepair = runSqliteDeferredTransactionSync(
        database,
        () =>
          scanTranscriptRows({
            database,
            pathname: params.pathname,
            legacyTextStorage,
          }) > 0 ||
          scanTrajectoryRows({
            database,
            pathname: params.pathname,
            rewrite: false,
          }) > 0,
        { databaseLabel: params.pathname, operationLabel: "media-persistence-detection" },
      );
      if (!needsRepair) {
        const rewrittenArchives = await migrateArchives();
        refreshAgentDatabasePlannerStatistics(database);
        return {
          rewrittenSessions: 0,
          rewrittenTrajectoryRows: 0,
          rewrittenArchives,
          initialVersion,
          finalVersion: userVersion,
        };
      }
    }

    const sourceVersion = readMediaSourceVersion(database, legacyTextStorage);
    const changedLegacySessions = new Set<string>();
    params.beforeTransaction?.();
    const owner = createMigrationDatabaseHandle(database, params.agentId, params.pathname);
    const rewritten = runSqliteImmediateTransactionSync(
      database,
      () => {
        assertMediaSchemaMigration();
        const currentSourceVersion = readMediaSourceVersion(database, legacyTextStorage);
        if (currentSourceVersion.dataVersion !== sourceVersion.dataVersion) {
          throw new Error(
            mediaSourceDriftMessage(params.pathname, sourceVersion, currentSourceVersion),
          );
        }
        const rewrittenSessions = scanTranscriptRows({
          database,
          pathname: params.pathname,
          writer: owner,
          legacyTextStorage,
          onChangedSession: legacyTextStorage
            ? (sessionId) => {
                changedLegacySessions.add(sessionId);
              }
            : undefined,
        });
        const rewrittenTrajectoryRows = scanTrajectoryRows({
          database,
          pathname: params.pathname,
          rewrite: true,
        });
        if (mediaSchemaUpgrade) {
          const db = getNodeSqliteKysely<MediaMigrationDatabase>(database);
          database.exec(`PRAGMA user_version = ${AGENT_MEDIA_SCHEMA_VERSION};`);
          executeSqliteQuerySync(
            database,
            db
              .updateTable("schema_meta")
              .set({
                app_version: VERSION,
                schema_version: AGENT_MEDIA_SCHEMA_VERSION,
                updated_at: Date.now(),
              })
              .where("meta_key", "=", "primary"),
          );
        }
        assertMediaSchemaMigration();
        return { rewrittenSessions, rewrittenTrajectoryRows };
      },
      {
        busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
        databaseLabel: params.pathname,
        operationLabel: "media-persistence-retirement",
      },
    );
    ensureOpenClawAgentDatabaseSchema(database, { agentId: params.agentId, path: params.pathname });
    if (changedLegacySessions.size > 0) {
      runSqliteImmediateTransactionSync(
        database,
        () => {
          assertAgentDatabaseMaintenanceAuthority();
          for (const sessionId of changedLegacySessions) {
            renewAgentDatabaseMaintenanceAuthorityIfPresent();
            reconcileSessionTranscriptIndexInTransaction(database, sessionId);
          }
          assertAgentDatabaseMaintenanceAuthority();
        },
        {
          busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
          databaseLabel: params.pathname,
          operationLabel: "media-persistence-projection",
        },
      );
    }
    const rewrittenArchives = await migrateArchives();
    refreshAgentDatabasePlannerStatistics(database);
    return {
      ...rewritten,
      rewrittenArchives,
      initialVersion,
      finalVersion: readSqliteUserVersion(database),
    };
  } finally {
    clearNodeSqliteKyselyCacheForDatabase(database);
    database.close();
  }
}

function readArchiveSourceSnapshot(filePath: string): ArchiveSourceSnapshot {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${filePath} is not a regular archive file`);
  }
  const bytes = fs.readFileSync(filePath);
  return {
    dev: stat.dev,
    ino: stat.ino,
    mtimeMs: stat.mtimeMs,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: stat.size,
  };
}

function archiveSourceMatches(filePath: string, expected: ArchiveSourceSnapshot): boolean {
  try {
    const current = readArchiveSourceSnapshot(filePath);
    return (
      current.dev === expected.dev &&
      current.ino === expected.ino &&
      current.mtimeMs === expected.mtimeMs &&
      current.sha256 === expected.sha256 &&
      current.size === expected.size
    );
  } catch {
    return false;
  }
}

function migrateTranscriptArchive(
  filePath: string,
  options: { beforeReplace?: () => void } = {},
): boolean {
  const source = readArchiveSourceSnapshot(filePath);
  const content = readSessionArchiveContentSync(filePath);
  const transformed = transformMediaArchiveContent(content, filePath);
  if (!transformed.changed) {
    return false;
  }
  const compressed = filePath.endsWith(SESSION_ARCHIVE_ZSTD_SUFFIX);
  const encoded = compressed
    ? encodeSessionArchiveContent(transformed.content)
    : { bytes: Buffer.from(transformed.content, "utf8"), suffix: "" as const };
  if (compressed && encoded.suffix !== SESSION_ARCHIVE_ZSTD_SUFFIX) {
    throw new Error(`${filePath} could not be re-encoded with its zstd codec`);
  }
  options.beforeReplace?.();
  replaceFileAtomicSync({
    filePath,
    content: encoded.bytes,
    preserveExistingMode: true,
    syncParentDir: true,
    syncTempFile: true,
    tempPrefix: `${path.basename(filePath)}${ARCHIVE_TEMP_MARKER}`,
    beforeRename: ({ tempPath }) => {
      if (!archiveSourceMatches(filePath, source)) {
        throw new Error(`${filePath} changed before atomic media migration replacement`);
      }
      const staged = decodeSessionArchiveBytes(fs.readFileSync(tempPath), compressed);
      if (staged !== transformed.content) {
        throw new Error(`${filePath} failed codec readback before replacement`);
      }
      assertEventIdentitiesUnchanged(
        parseArchiveContent(transformed.content, filePath),
        parseArchiveContent(staged, tempPath),
        filePath,
      );
    },
  });
  if (readSessionArchiveContentSync(filePath) !== transformed.content) {
    throw new Error(`${filePath} failed codec readback after replacement`);
  }
  return true;
}

/** Doctor-only migration from top-level Media* transcript fields to canonical facts. */
export async function migrateLegacyMediaPersistence(
  params: {
    configuredAgentDatabaseTargets?: readonly { agentId: string; path: string }[];
    preparedDiscovery?: PreparedAgentDatabaseMigrationDiscovery;
    onPreparedTargets?: (targets: readonly AgentDatabaseMigrationTarget[]) => void;
    hooks?: {
      beforeArchiveReplace?: (archivePath: string) => void;
      beforeDatabaseTransaction?: (databasePath: string) => void;
    };
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<MigrationMessages> {
  const env = params.env ?? process.env;
  const changes: string[] = [];
  const warnings: string[] = [];
  let recoverableWarningCount = 0;
  const refusedAgentDatabasePaths: string[] = [];
  const recoveredAgentDatabasePaths = new Set<string>();
  try {
    const preparedDiscovery = prepareAgentDatabaseMigrationDiscovery({
      env,
      configuredAgentDatabaseTargets: params.configuredAgentDatabaseTargets ?? [],
      preparedDiscovery: params.preparedDiscovery,
    });
    const advisory = agentDatabaseMigrationAdvisory(preparedDiscovery.discovery);
    if (advisory) {
      params.onPreparedTargets?.([]);
      return advisory;
    }
    await withAgentDatabaseMaintenanceLease({ env }, async (maintenance) => {
      const discovery = resolveAgentDatabaseMigrationTargets({
        changes,
        configuredAgentDatabaseTargets: params.configuredAgentDatabaseTargets ?? [],
        env,
        warnings,
        preparedDiscovery,
      });
      recoverableWarningCount = discovery.recoverableWarningCount;
      const recoveries = recoverMisplacedAgentDatabaseCopies({
        targets: discovery.targets,
        maintenance,
      });
      const seenPaths = new Set<string>();
      const archiveDirectories = new Set<string>();
      const canonicalArchivePaths = new Set<string>();
      const refusedArchiveDirectories = new Set<string>();
      for (const entry of discovery.targets) {
        const pathname = entry.path;
        const recovery = recoveries.get(pathname);
        if (recovery) {
          maintenance.assertOwned();
          warnings.push(recovery.warning);
          if (recovery.recovered) {
            recoveredAgentDatabasePaths.add(pathname);
            recoveredAgentDatabasePaths.add(entry.realPath);
            unregisterOpenClawAgentDatabase({ agentId: entry.agentId, env, path: pathname });
            recoverableWarningCount += 1;
          } else {
            refusedAgentDatabasePaths.push(pathname);
            refusedArchiveDirectories.add(
              resolveSqliteTranscriptArchiveDirectory({ agentId: entry.agentId, path: pathname }),
            );
          }
          continue;
        }
        archiveDirectories.add(
          resolveSqliteTranscriptArchiveDirectory({
            agentId: entry.agentId,
            path: pathname,
          }),
        );
        if (seenPaths.has(entry.realPath)) {
          continue;
        }
        seenPaths.add(entry.realPath);
        try {
          const result = await migrateAgentDatabase({
            agentId: entry.agentId,
            canonicalArchivePaths,
            beforeTransaction: params.hooks?.beforeDatabaseTransaction
              ? () => params.hooks?.beforeDatabaseTransaction?.(pathname)
              : undefined,
            pathname,
          });
          maintenance.assertOwned();
          // A prior attempt may have committed the schema before publishing its registration.
          registerOpenClawAgentDatabase({ agentId: entry.agentId, env, path: pathname });
          const schemaAdvanced = result.finalVersion > result.initialVersion;
          if (schemaAdvanced) {
            changes.push(
              `Upgraded agent database schema in ${pathname}: v${result.initialVersion} -> v${result.finalVersion}.`,
            );
          }
          if (result.rewrittenSessions > 0 || result.rewrittenTrajectoryRows > 0) {
            changes.push(
              `Migrated media persistence in ${pathname}: ${result.rewrittenSessions} transcript session(s), ${result.rewrittenTrajectoryRows} trajectory row(s), schema v${OPENCLAW_AGENT_SCHEMA_VERSION}.`,
            );
          }
          if (result.rewrittenArchives > 0) {
            changes.push(
              `Migrated canonical transcript archive media in ${pathname}: ${result.rewrittenArchives} archive(s).`,
            );
          }
        } catch (error) {
          // An unverified database may own files in this directory. Never fall
          // back to file-only repair after its canonical archive repair refuses.
          refusedArchiveDirectories.add(
            resolveSqliteTranscriptArchiveDirectory({ agentId: entry.agentId, path: pathname }),
          );
          warnings.push(`Skipped agent database migration for ${pathname}: ${String(error)}`);
        }
      }

      for (const directory of archiveDirectories) {
        if (refusedArchiveDirectories.has(directory)) {
          continue;
        }
        let archives: string[];
        try {
          archives = listTranscriptArchives(directory);
        } catch (error) {
          warnings.push(
            `Could not enumerate transcript archives in ${directory}: ${String(error)}`,
          );
          recoverableWarningCount += 1;
          continue;
        }
        for (const archive of archives) {
          if (canonicalArchivePaths.has(path.resolve(archive))) {
            continue;
          }
          try {
            if (
              migrateTranscriptArchive(archive, {
                beforeReplace: params.hooks?.beforeArchiveReplace
                  ? () => params.hooks?.beforeArchiveReplace?.(archive)
                  : undefined,
              })
            ) {
              changes.push(`Migrated archived transcript media in ${archive}.`);
            }
          } catch (error) {
            warnings.push(
              `Skipped archived transcript media migration for ${archive}: ${String(error)}`,
            );
            recoverableWarningCount += 1;
          }
        }
      }
      params.onPreparedTargets?.(
        discovery.targets.filter((target) => !recoveries.get(target.path)?.recovered),
      );
    });
  } catch (error) {
    warnings.push(`Agent database maintenance deferred: ${formatErrorMessage(error)}`);
  }
  return {
    changes,
    warnings,
    ...(recoveredAgentDatabasePaths.size > 0
      ? { recoveredAgentDatabasePaths: [...recoveredAgentDatabasePaths] }
      : {}),
    ...(warnings.length > 0 && warnings.length === recoverableWarningCount
      ? { warningDisposition: "recoverable" as const }
      : warnings.length === recoverableWarningCount + refusedAgentDatabasePaths.length &&
          refusedAgentDatabasePaths.length > 0
        ? { refusedAgentDatabasePaths }
        : {}),
  };
}
