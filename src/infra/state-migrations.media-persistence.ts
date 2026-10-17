import fs from "node:fs";
import path from "node:path";
import { readRegularFileSync } from "@openclaw/fs-safe/advanced";
import { replaceFileAtomicSync } from "@openclaw/fs-safe/atomic";
import {
  decodeSessionArchiveBytes,
  readSessionArchiveContentSync,
  SESSION_ARCHIVE_ZSTD_SUFFIX,
} from "../config/sessions/archive-compression.js";
import { resolveSqliteTranscriptArchiveDirectory } from "../config/sessions/session-accessor.sqlite-scope.js";
import { reconcileSessionTranscriptIndexInTransaction } from "../config/sessions/session-transcript-index.js";
import {
  AGENT_MEDIA_SCHEMA_VERSION,
  AGENT_STORAGE_SCHEMA_VERSION,
  AGENT_TRAJECTORY_STORAGE_SCHEMA_VERSION,
  MEDIA_ROWS_MIGRATION_META_KEY,
} from "../state/openclaw-agent-db-contract.js";
import { agentEngineInput } from "../state/openclaw-agent-db-engine.js";
import {
  invalidateOpenClawAgentDatabaseIntegrityBeforeMutation,
  renewAgentDatabaseMaintenanceAuthorityIfPresent,
} from "../state/openclaw-agent-db-lease.js";
import { agentDatabaseLifecycle } from "../state/openclaw-agent-db-lifecycle.js";
import { assertAgentDatabaseMaintenanceAuthority } from "../state/openclaw-agent-db-maintenance-authority.js";
import { withAgentDatabaseMaintenanceLease } from "../state/openclaw-agent-db-maintenance-lease.js";
import {
  assertOpenClawAgentDatabaseForMaintenance,
  assertOpenClawAgentDatabaseOwner,
} from "../state/openclaw-agent-db-maintenance.js";
import { migrateOpenClawAgentDatabaseToMediaPrerequisiteSchemaSteps } from "../state/openclaw-agent-db-media-migration.js";
import {
  registerOpenClawAgentDatabase,
  unregisterOpenClawAgentDatabase,
} from "../state/openclaw-agent-db-registry.js";
import { admitOpenClawAgentDatabaseSchema } from "../state/openclaw-agent-db-schema-admission.js";
import {
  assertOpenClawAgentSchemaContains,
  assertSupportedAgentSchemaVersion,
  getOpenClawAgentMigrationSchema,
  hasPendingCurrentVersionAgentDatabaseMigration,
} from "../state/openclaw-agent-db-schema-helpers.js";
import {
  ensureOpenClawAgentDatabaseSchemaSteps,
  ensureOpenClawAgentSchema,
} from "../state/openclaw-agent-db-schema.js";
import { assertSupportedAgentMigrationSchemas } from "../state/openclaw-agent-db-session-migrations.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import {
  OPENCLAW_AGENT_SCHEMA_VERSION,
  clearOpenClawAgentDatabaseOpenFailure,
} from "../state/openclaw-agent-db.js";
import { readOpenClawDatabaseQuarantineFailure } from "../state/openclaw-quarantine-store.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "../state/openclaw-state-db.js";
import type { OpenClawStateLeaseContext } from "../state/openclaw-state-lease.js";
import { VERSION } from "../version.js";
import { isTruthyEnvValue } from "./env.js";
import { formatErrorMessage } from "./errors.js";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  enableNodeSqliteKyselyStatementCache,
} from "./kysely-sync.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import {
  backupDoctorSqliteRepair,
  repairDoctorSqliteIndexCorruption,
} from "./sqlite-index-recovery.js";
import { repairCanonicalSqliteIndexes } from "./sqlite-index-schema.js";
import { runSqliteIntegrityOperationInWorker } from "./sqlite-integrity-operation.js";
import { assertSqliteIntegrity, isTerminalSqliteIntegrityError } from "./sqlite-integrity.js";
import { configureSqliteMaintenanceCache } from "./sqlite-maintenance-cache.js";
import { refreshSqlitePlannerStatistics } from "./sqlite-planner-statistics.js";
import { resolveSqliteInspectionSignal } from "./sqlite-readonly-worker.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";
import { readSqliteUserVersion } from "./sqlite-user-version.js";
import { createMigrationDatabaseHandle } from "./state-migrations.agent-database.js";
import { formatAgentDatabaseCorruptionRepairHint } from "./state-migrations.agent-owner-guidance.js";
import { recoverMisplacedAgentDatabaseCopies } from "./state-migrations.agent-owner-recovery.js";
import {
  scanTranscriptRows,
  scanTrajectoryRows,
} from "./state-migrations.media-persistence-database.js";
import {
  hasMediaRowsMigrationReceipt,
  inspectPostgresMediaPersistence,
} from "./state-migrations.media-persistence-inspection.js";
import {
  listTranscriptArchives,
  prepareAgentDatabaseMigrationDiscovery,
  agentDatabaseMigrationAdvisory,
  resolveAgentDatabaseMigrationTargets,
  type AgentDatabaseMigrationTarget,
  type PreparedAgentDatabaseMigrationDiscovery,
} from "./state-migrations.media-persistence-targets.js";
import { transformMediaArchiveContent } from "./state-migrations.media-persistence-transform.js";
import { repairDoctorSessionWindowOrphans } from "./state-migrations.session-window-repair.js";
import {
  encodeArchiveContent,
  MEDIA_ARCHIVE_VERIFICATION_KEY,
  migrateCanonicalTranscriptArchives,
} from "./state-migrations.transcript-directives-archives.js";
import type { MigrationMessages } from "./state-migrations.types.js";

const PREVIOUS_MEDIA_SCHEMA_VERSION = AGENT_MEDIA_SCHEMA_VERSION - 1;
const ARCHIVE_TEMP_MARKER = ".media-retirement";

type MediaMigrationDatabase = Pick<OpenClawAgentKyselyDatabase, "schema_meta">;

async function migrateAgentDatabase(params: {
  agentId: string;
  canonicalArchivePaths: Set<string>;
  changes: string[];
  env: NodeJS.ProcessEnv;
  pathname: string;
  maintenance: OpenClawStateLeaseContext;
  preparedArchives?: ReadonlySet<string>;
  migratedFromVersion?: number;
  integrityCheck?: "quick" | "full";
}) {
  if (agentEngineInput()) {
    return inspectPostgresMediaPersistence(params);
  }
  const database = openNodeSqliteDatabase(params.pathname);
  const nativeVersionMigration = params.migratedFromVersion !== undefined && !agentEngineInput();
  const schemaWarnings: string[] = [];
  const schemaOptions = {
    agentId: params.agentId,
    path: params.pathname,
    env: params.env,
    integrityCheck: params.integrityCheck,
    // Register with the admitted handle; registering after close revokes its proof.
    register: true,
    onMigrationWarning: (warning: string) => schemaWarnings.push(warning),
  };
  const runSchema = (operation: Parameters<typeof runSqliteIntegrityOperationInWorker>[0]) =>
    runSqliteIntegrityOperationInWorker(operation, {
      busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
      signal: params.maintenance.signal,
      beforeResume: () => assertAgentDatabaseMaintenanceAuthority(params.maintenance),
    });
  try {
    configureSqliteMaintenanceCache(database);
    database.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
    enableNodeSqliteKyselyStatementCache(database);
    let metadata = assertOpenClawAgentDatabaseOwner(database, params);
    assertSupportedAgentSchemaVersion(database, params.pathname);
    let userVersion = readSqliteUserVersion(database);
    if (userVersion < OPENCLAW_AGENT_SCHEMA_VERSION) {
      assertSupportedAgentMigrationSchemas(database, params.pathname, userVersion);
    }
    if (
      isTruthyEnvValue(params.env.OPENCLAW_UPDATE_IN_PROGRESS) &&
      userVersion === OPENCLAW_AGENT_SCHEMA_VERSION &&
      !hasPendingCurrentVersionAgentDatabaseMigration(database) &&
      !agentDatabaseLifecycle.terminal.peek(params.pathname) &&
      !readOpenClawDatabaseQuarantineFailure("agent", params.pathname, {
        env: params.env,
        fresh: true,
      }) &&
      !assertOpenClawAgentDatabaseForMaintenance(database, {
        agentId: params.agentId,
        pathname: params.pathname,
        allowStartupIndexRepair: true,
      })
    ) {
      // Unchanged stores keep their clean-close proof. Explicit Doctor owns
      // content repairs; an update only prepares stores needing migration.
      registerOpenClawAgentDatabase(schemaOptions);
      return {
        deferred: true,
        rewrittenSessions: 0,
        rewrittenTrajectoryRows: 0,
        rewrittenArchives: 0,
        warnings: [],
        initialVersion: userVersion,
        finalVersion: userVersion,
      };
    }
    if (!nativeVersionMigration) {
      invalidateOpenClawAgentDatabaseIntegrityBeforeMutation(params.pathname);
    }
    const initialVersion = params.migratedFromVersion ?? userVersion;
    const prepareSchema = async () => {
      userVersion = readSqliteUserVersion(database);
      if (userVersion <= PREVIOUS_MEDIA_SCHEMA_VERSION) {
        await runSchema(
          migrateOpenClawAgentDatabaseToMediaPrerequisiteSchemaSteps(database, schemaOptions),
        );
        metadata = assertOpenClawAgentDatabaseOwner(database, params);
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
        if (params.migratedFromVersion !== undefined) {
          // The version phase verified this file under the same Doctor custody.
          // Only ordinary additive maintenance remains before readers can open it.
          ensureOpenClawAgentSchema(database, params.agentId, params.pathname);
          const admittedDb = nativeVersionMigration
            ? admitOpenClawAgentDatabaseSchema(database, schemaOptions)
            : undefined;
          registerOpenClawAgentDatabase({ ...schemaOptions, admittedDb });
        } else {
          await runSchema(ensureOpenClawAgentDatabaseSchemaSteps(database, schemaOptions));
        }
        userVersion = readSqliteUserVersion(database);
      }
    };
    let integrityChanges: string[] = [];
    try {
      await prepareSchema();
    } catch (error) {
      if (!(error instanceof Error) || !isTerminalSqliteIntegrityError(error)) {
        throw error;
      }
      // Admission already checks the whole file. Only a proven integrity failure
      // needs Doctor's preserving repair scan under an immediate transaction.
      const assertCurrent = () => {
        assertAgentDatabaseMaintenanceAuthority(params.maintenance);
        assertOpenClawAgentDatabaseOwner(database, params);
      };
      integrityChanges = repairDoctorSqliteIndexCorruption(database, params.pathname, {
        label: `agent ${params.agentId}`,
        assertCurrent,
      });
      if (integrityChanges.length === 0) {
        integrityChanges = repairDoctorSessionWindowOrphans(
          database,
          params.pathname,
          assertCurrent,
        );
      }
      params.changes.push(...integrityChanges);
      await prepareSchema();
    }
    if (
      integrityChanges.length > 0 ||
      agentDatabaseLifecycle.terminal.peek(params.pathname) ||
      readOpenClawDatabaseQuarantineFailure("agent", params.pathname, {
        env: params.env,
        fresh: true,
      })
    ) {
      runSqliteImmediateTransactionSync(
        database,
        () => {
          if (integrityChanges.length === 0) {
            assertSqliteIntegrity(database, params.pathname);
          }
          assertAgentDatabaseMaintenanceAuthority();
          assertOpenClawAgentDatabaseOwner(database, params);
          if (!clearOpenClawAgentDatabaseOpenFailure(params.pathname, { env: params.env })) {
            throw new Error(
              `Repaired ${params.pathname}, but its quarantine record could not be cleared.`,
            );
          }
        },
        {
          databaseLabel: params.pathname,
          operationLabel: "media-persistence.quarantine-clear",
        },
      );
    }
    if (initialVersion >= AGENT_MEDIA_SCHEMA_VERSION && userVersion > initialVersion) {
      // Version migrations own only their declared tables. Historical content
      // repair remains a separate same-version Doctor operation.
      return {
        deferred: true,
        rewrittenSessions: 0,
        rewrittenTrajectoryRows: 0,
        rewrittenArchives: 0,
        warnings: schemaWarnings,
        initialVersion,
        finalVersion: userVersion,
      };
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
    const schemaSql = getOpenClawAgentMigrationSchema(userVersion);
    if (userVersion === PREVIOUS_MEDIA_SCHEMA_VERSION) {
      repairCanonicalSqliteIndexes(database, params.pathname, schemaSql, {
        integrity: { check: params.integrityCheck ?? "quick" },
        validateAfterRepair: () =>
          assertOpenClawAgentSchemaContains(database, params.pathname, schemaSql, schemaMode),
      });
    }
    assertOpenClawAgentSchemaContains(database, params.pathname, schemaSql, schemaMode);
    const legacyTextStorage = userVersion < AGENT_STORAGE_SCHEMA_VERSION;
    const db = getNodeSqliteKysely<MediaMigrationDatabase>(database);
    const needsRepair = mediaSchemaUpgrade || !hasMediaRowsMigrationReceipt(database);
    let rewritten = { rewrittenSessions: 0, rewrittenTrajectoryRows: 0 };
    let preserved = false;
    const beforeRewrite = () => {
      if (!preserved) {
        const backup = backupDoctorSqliteRepair(params.pathname, "media-persistence");
        preserved = true;
        params.changes.push(`Saved pre-repair SQLite backup: ${backup}`);
      }
    };
    if (needsRepair) {
      const changedLegacySessions = new Set<string>();
      const owner = createMigrationDatabaseHandle(database, params.agentId, params.pathname);
      rewritten = runSqliteImmediateTransactionSync(
        database,
        () => {
          assertAgentDatabaseMaintenanceAuthority(params.maintenance);
          assertMediaSchemaMigration();
          const rewrittenSessions = scanTranscriptRows({
            database,
            pathname: params.pathname,
            writer: owner,
            legacyTextStorage,
            beforeRewrite,
            onChangedSession: legacyTextStorage
              ? (sessionId) => {
                  changedLegacySessions.add(sessionId);
                }
              : undefined,
          });
          const rewrittenTrajectoryRows = scanTrajectoryRows({
            database,
            pathname: params.pathname,
            legacyTextStorage: userVersion < AGENT_TRAJECTORY_STORAGE_SCHEMA_VERSION,
            beforeRewrite,
          });
          if (mediaSchemaUpgrade) {
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
          // Current writers canonicalize media. Unsupported direct writes after
          // completion do not reopen this historical pass.
          const now = Date.now();
          executeSqliteQuerySync(
            database,
            db
              .insertInto("schema_meta")
              .values({
                meta_key: MEDIA_ROWS_MIGRATION_META_KEY,
                role: "agent",
                agent_id: params.agentId,
                schema_version: 1,
                app_version: VERSION,
                created_at: now,
                updated_at: now,
              })
              .onConflict((conflict) => conflict.column("meta_key").doNothing()),
          );
          assertAgentDatabaseMaintenanceAuthority(params.maintenance);
          assertMediaSchemaMigration();
          return { rewrittenSessions, rewrittenTrajectoryRows };
        },
        {
          busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
          databaseLabel: params.pathname,
          operationLabel: "media-persistence-retirement",
        },
      );
      if (mediaSchemaUpgrade) {
        await runSchema(ensureOpenClawAgentDatabaseSchemaSteps(database, schemaOptions));
        userVersion = readSqliteUserVersion(database);
      }
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
    }
    const archives = await migrateCanonicalTranscriptArchives({
      agentId: params.agentId,
      database,
      pathname: params.pathname,
      signal: params.maintenance.signal,
      start: { generation: "", sessionId: "" },
      verification: { key: MEDIA_ARCHIVE_VERIFICATION_KEY, prepared: params.preparedArchives },
      onArchive: (archivePath) => params.canonicalArchivePaths.add(archivePath),
      beforeRewrite,
      transformLine: transformMediaArchiveContent,
    });
    refreshSqlitePlannerStatistics(database);
    return {
      deferred: false,
      ...rewritten,
      ...archives,
      warnings: [...schemaWarnings, ...archives.warnings],
      initialVersion,
      finalVersion: userVersion,
    };
  } finally {
    database.close();
  }
}

function archiveSourceMatches(
  filePath: string,
  expected: ReturnType<typeof readRegularFileSync>,
): boolean {
  try {
    const current = readRegularFileSync({ filePath });
    return (
      current.exactIdentity.dev === expected.exactIdentity.dev &&
      current.exactIdentity.ino === expected.exactIdentity.ino &&
      current.stat.mtimeMs === expected.stat.mtimeMs &&
      current.stat.size === expected.stat.size &&
      current.buffer.equals(expected.buffer)
    );
  } catch {
    return false;
  }
}

function migrateTranscriptArchive(
  filePath: string,
  options: { beforeReplace?: () => void } = {},
): boolean {
  const source = readRegularFileSync({ filePath });
  const compressed = filePath.endsWith(SESSION_ARCHIVE_ZSTD_SUFFIX);
  const content = decodeSessionArchiveBytes(source.buffer, compressed);
  const transformed = transformMediaArchiveContent(content, filePath);
  if (!transformed.changed) {
    return false;
  }
  const codec = compressed ? "zstd" : "identity";
  const encoded = encodeArchiveContent(transformed.content, codec, filePath);
  options.beforeReplace?.();
  replaceFileAtomicSync({
    filePath,
    content: encoded,
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
    integrityCheck?: "quick" | "full";
    onPreparedRepairTargets?: (targets: readonly AgentDatabaseMigrationTarget[]) => void;
    hooks?: {
      beforeArchiveReplace?: (archivePath: string) => void;
    };
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<MigrationMessages> {
  const inspectionSignal = resolveSqliteInspectionSignal();
  inspectionSignal?.throwIfAborted();
  const env = params.env ?? process.env;
  const changes: string[] = [];
  const warnings: string[] = [];
  const notices: string[] = [];
  let recoverableWarningCount = 0;
  const refusedAgentDatabasePaths: string[] = [];
  const recoveredAgentDatabasePaths = new Set<string>();
  const preparedRepairTargets: AgentDatabaseMigrationTarget[] = [];
  try {
    const preparedDiscovery = prepareAgentDatabaseMigrationDiscovery({
      env,
      configuredAgentDatabaseTargets: params.configuredAgentDatabaseTargets ?? [],
      preparedDiscovery: params.preparedDiscovery,
    });
    const advisory = agentDatabaseMigrationAdvisory(preparedDiscovery.discovery);
    if (advisory) {
      params.onPreparedRepairTargets?.([]);
      return advisory;
    }
    const { discovery, recoveries } = await withAgentDatabaseMaintenanceLease(
      { env, processBound: true },
      async (maintenance) => {
        const signal = resolveSqliteInspectionSignal(maintenance.signal) ?? maintenance.signal;
        signal.throwIfAborted();
        const discovered = resolveAgentDatabaseMigrationTargets({
          changes,
          configuredAgentDatabaseTargets: params.configuredAgentDatabaseTargets ?? [],
          env,
          warnings,
          preparedDiscovery,
        });
        recoverableWarningCount = discovered.recoverableWarningCount;
        if (discovered.pendingDeletionTargets.length > 0) {
          const { preparePendingAgentDeletionDatabasesForMaintenance } =
            await import("../state/openclaw-agent-db-maintenance.js");
          changes.push(
            ...(await preparePendingAgentDeletionDatabasesForMaintenance(
              { targets: discovered.pendingDeletionTargets, env },
              maintenance,
            )),
          );
        }
        const recovered = recoverMisplacedAgentDatabaseCopies({
          targets: discovered.targets,
          maintenance,
        });
        for (const entry of discovered.targets) {
          if (recovered.get(entry.path)?.recovered) {
            maintenance.assertOwned();
            unregisterOpenClawAgentDatabase({ agentId: entry.agentId, env, path: entry.path });
          }
        }
        return { discovery: discovered, recoveries: recovered };
      },
    );
    const seenPaths = new Set<string>();
    const archiveDirectories = new Set<string>();
    const canonicalArchivePaths = new Set<string>();
    const refusedArchiveDirectories = new Set<string>();
    for (const entry of discovery.targets) {
      inspectionSignal?.throwIfAborted();
      const pathname = entry.path;
      const recovery = recoveries.get(pathname);
      if (recovery) {
        warnings.push(recovery.warning);
        if (recovery.recovered) {
          recoveredAgentDatabasePaths.add(pathname);
          recoveredAgentDatabasePaths.add(entry.realPath);
          recoverableWarningCount += 1;
        } else {
          refusedAgentDatabasePaths.push(pathname);
          refusedArchiveDirectories.add(
            resolveSqliteTranscriptArchiveDirectory({ agentId: entry.agentId, path: pathname }),
          );
        }
        continue;
      }
      if (seenPaths.has(entry.realPath)) {
        continue;
      }
      seenPaths.add(entry.realPath);
      try {
        const preparedForRepair = await withAgentDatabaseMaintenanceLease(
          { env, processBound: true },
          async (maintenance) => {
            const result = await migrateAgentDatabase({
              agentId: entry.agentId,
              changes,
              env,
              canonicalArchivePaths,
              pathname,
              maintenance,
              integrityCheck: params.integrityCheck,
              preparedArchives: preparedDiscovery.preparedTranscriptArchives,
              migratedFromVersion: preparedDiscovery.versionMigrations?.find(
                (migration) => migration.path === pathname,
              )?.foundVersion,
            });
            maintenance.assertOwned();
            if (!result.deferred) {
              archiveDirectories.add(
                resolveSqliteTranscriptArchiveDirectory({
                  agentId: entry.agentId,
                  path: pathname,
                }),
              );
            }
            warnings.push(...result.warnings);
            recoverableWarningCount += result.warnings.length;
            const schemaAdvanced = result.finalVersion > result.initialVersion;
            if (
              schemaAdvanced &&
              !preparedDiscovery.versionMigrations?.some((migration) => migration.path === pathname)
            ) {
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
            // Only a version-only advance postpones the following Doctor repairs.
            return !result.deferred || !schemaAdvanced;
          },
        );
        if (preparedForRepair) {
          preparedRepairTargets.push(entry);
        }
      } catch (error) {
        if (inspectionSignal?.aborted && error === inspectionSignal.reason) {
          throw error;
        }
        // An unverified database may own files in this directory. Never fall
        // back to file-only repair after its canonical archive repair refuses.
        refusedArchiveDirectories.add(
          resolveSqliteTranscriptArchiveDirectory({ agentId: entry.agentId, path: pathname }),
        );
        warnings.push(`Skipped agent database migration for ${pathname}: ${String(error)}`);
        const repairHint = formatAgentDatabaseCorruptionRepairHint(entry.agentId, error);
        if (repairHint) {
          notices.push(repairHint);
        }
      }
    }

    if (archiveDirectories.size > 0) {
      await withAgentDatabaseMaintenanceLease({ env, processBound: true }, async (maintenance) => {
        for (const directory of archiveDirectories) {
          inspectionSignal?.throwIfAborted();
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
            inspectionSignal?.throwIfAborted();
            if (canonicalArchivePaths.has(path.resolve(archive))) {
              continue;
            }
            try {
              maintenance.renew?.();
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
              if (inspectionSignal?.aborted && error === inspectionSignal.reason) {
                throw error;
              }
              warnings.push(
                `Skipped archived transcript media migration for ${archive}: ${String(error)}`,
              );
              recoverableWarningCount += 1;
            }
          }
        }
      });
    }
  } catch (error) {
    if (inspectionSignal?.aborted && error === inspectionSignal.reason) {
      throw error;
    }
    warnings.push(`Agent database maintenance deferred: ${formatErrorMessage(error)}`);
  }
  params.onPreparedRepairTargets?.(preparedRepairTargets);
  return {
    changes,
    warnings,
    ...(notices.length > 0 ? { notices } : {}),
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
