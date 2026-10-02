import type { DatabaseSync } from "node:sqlite";
import {
  migrateMemoryIndexSourcesIdentity,
  migrateMemoryIndexStorage,
} from "../../packages/memory-host-sdk/src/host/memory-schema.js";
import { migrateSessionCostUsageRollupStorage } from "../infra/session-cost-usage-cache-migration.js";
import { setSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
import { revokeSqliteDatabaseAdmissions } from "../infra/sqlite-database-admission.js";
import {
  repairCanonicalSqliteIndexes,
  verifyAndRepairCanonicalSqliteIndexSteps,
} from "../infra/sqlite-index-schema.js";
import {
  assertSqliteIntegrity,
  runSqliteIntegrityOperationSync,
  sqliteIntegrityCheckSteps,
  type SqliteIntegrityDiagnostics,
  type SqliteIntegrityOperation,
} from "../infra/sqlite-integrity.js";
import type { SqliteTableContractReader } from "../infra/sqlite-schema-contract.js";
import {
  admitSqliteSchema,
  getAdmittedSqliteSchemaFacts,
  invalidateSqliteSchemaFacts,
  isSqliteSchemaAdmissionCold,
} from "../infra/sqlite-schema-facts.js";
import { migrateSqliteSchemaToStrictInTransaction } from "../infra/sqlite-strict.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { configureSqlitePreSchemaPragmas } from "../infra/sqlite-wal.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  admitAgentDatabaseStartupStructure,
  type AgentDatabaseStartupIntegrity,
} from "./agent-database-startup-integrity.js";
import { assertAgentDeletionRecoveryAllowsMutation } from "./agent-deletion-journal-recovery.js";
import * as agentDeletion from "./agent-deletion-journal.js";
import { ensureOpenClawAgentBoardSchemaInTransaction } from "./openclaw-agent-board-schema.js";
import {
  ensureLegacySessionEntryValidityTriggers,
  migrateCanonicalSessionWriterValidation,
  seedCanonicalSessionValidationPending,
} from "./openclaw-agent-canonical-validation-migration.js";
import {
  adoptCanonicalSessionValidationSchema,
  canonicalSessionValidationSchemaSql,
} from "./openclaw-agent-canonical-validation-schema.js";
import { AGENT_COLD_ARCHIVE_CHUNKS_SQL } from "./openclaw-agent-cold-archive-chunks-schema.js";
import { migrateAgentColdNavigationInTransaction } from "./openclaw-agent-cold-navigation-schema.js";
import {
  AGENT_COLD_ARCHIVE_CHUNKS_SCHEMA_VERSION,
  AGENT_COLD_NAVIGATION_SCHEMA_VERSION,
  AGENT_INDEX_RETIREMENT_SCHEMA_VERSION,
  AGENT_MEDIA_SCHEMA_VERSION,
  AGENT_MEMORY_REVISION_SCHEMA_VERSION,
  AGENT_STORAGE_SCHEMA_VERSION,
  AGENT_JSON_PREDICATE_SCHEMA_VERSION,
  AGENT_OUTBOX_SEQUENCE_SCHEMA_VERSION,
  AGENT_WRITE_LAYOUT_SCHEMA_VERSION,
  AGENT_TRAJECTORY_STORAGE_SCHEMA_VERSION,
  CANONICAL_SESSION_VALIDATION_SCHEMA_VERSION,
  CANONICAL_SESSION_WRITER_VALIDATION_SCHEMA_VERSION,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  TRANSCRIPT_FTS_ROW_SCHEMA_VERSION,
  type OpenClawAgentDatabaseOptions,
} from "./openclaw-agent-db-contract.js";
import * as maintenanceAuthority from "./openclaw-agent-db-lease.js";
import { migrateOpenClawAgentSchema } from "./openclaw-agent-db-legacy-schema.js";
import * as maintenanceLease from "./openclaw-agent-db-maintenance-authority.js";
import { persistAgentSchemaMetadata } from "./openclaw-agent-db-metadata-write.js";
import { ensureOpenClawAgentDatabasePermissions } from "./openclaw-agent-db-permissions.js";
import { registerOpenClawAgentDatabase } from "./openclaw-agent-db-registry.js";
import { admitOpenClawAgentDatabaseSchema } from "./openclaw-agent-db-schema-admission.js";
import {
  getOpenClawAgentMigrationSchema,
  assertExistingAgentSchemaOwner,
  assertOpenClawAgentCurrentRuntimeSchema,
  assertOpenClawAgentSchemaContains,
  assertSupportedAgentSchemaVersion,
  assertAgentSchemaVersion,
  finishAgentSchemaMigration,
  hasPendingCurrentVersionAgentDatabaseMigration,
  hasPendingMemoryChunkMetadataMigration,
  migrateMemoryChunkMetadataSchema,
  migrateRetiredAgentStateLeaseSchema,
  ensureSessionKeyContractSchemaInTransaction,
  ensureSessionReactionsSchemaInTransaction,
  readExistingAgentSchemaMeta,
  repairAndAssertOpenClawAgentV14SchemaForMigration,
} from "./openclaw-agent-db-schema-helpers.js";
import { hasAgentDatabaseApplicationSchema } from "./openclaw-agent-db-schema-read.js";
import {
  backfillSessionConversations,
  assertSupportedAgentMigrationSchemas,
  ensureSessionAdditiveColumns,
  ensureSessionEntryValidityProjection,
  migrateConversationDeliveryTargetColumn,
  migrateSessionCreatorNamespaces,
  migrateSessionTranscriptActiveProjection,
  migrateSessionTranscriptGenerations,
} from "./openclaw-agent-db-session-migrations.js";
import { migrateSessionNodesAndWindows } from "./openclaw-agent-db-session-nodes-migration.js";
import {
  isPersistentOpenClawAgentDatabasePath,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.paths.js";
import { AGENT_INDEX_RETIREMENT_SQL } from "./openclaw-agent-index-retirement-migration.js";
import { migrateAgentJsonPredicatesInTransaction } from "./openclaw-agent-json-predicate-schema.js";
import { AGENT_MEMORY_REVISION_SQL } from "./openclaw-agent-memory-revision-migration.js";
import { migrateOutboxEnqueueSequenceInTransaction } from "./openclaw-agent-outbox-sequence-migration.js";
import { migrateSessionParticipantsSchema } from "./openclaw-agent-participants-migration.js";
import { interruptHistoricalPendingInputs } from "./openclaw-agent-pending-inputs-schema.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import { migrateSessionEntrySnapshotsInTransaction } from "./openclaw-agent-session-snapshots-migration.js";
import {
  SESSION_ENTRY_SNAPSHOTS_SCHEMA_VERSION,
  withoutSessionEntrySnapshotsSchema,
} from "./openclaw-agent-session-snapshots-schema.js";
import { withLegacyAgentStorageSchema } from "./openclaw-agent-storage-schema.js";
import {
  migrateAgentTrajectoryStorageInTransaction,
  withoutTrajectoryPayloadColumns,
} from "./openclaw-agent-trajectory-storage-migration.js";
import { migrateDeployedTranscriptFtsRowsInTransaction } from "./openclaw-agent-transcript-fts-schema.js";
import { migrateTranscriptPayloadStorageInTransaction } from "./openclaw-agent-transcript-payload-migration.js";
import { migrateAgentWriteLayoutInTransaction } from "./openclaw-agent-write-layout-migration.js";
import { getOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import {
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { resolveSchemaMigrationIntegrityCheck } from "./schema-migration-backup-scope.js";
import { resolveSchemaMigrationIntegrityTables } from "./schema-migration-integrity-tables.js";

const agentDbLog = createSubsystemLogger("state/agent-db");

export function* agentDatabaseIntegrityBeforeMutationSteps(
  database: DatabaseSync,
  agentId: string,
  pathname: string,
  diagnostics?: SqliteIntegrityDiagnostics,
  verification?: { verifiedAt: number },
  reuseRuntimeIntegrity = false,
  admittedSchema = false,
  integrityCheck?: "quick" | "full",
  integrityTables?: readonly string[],
  startupIntegrity?: AgentDatabaseStartupIntegrity,
): SqliteIntegrityOperation<boolean> {
  if (reuseRuntimeIntegrity && admittedSchema) {
    if (diagnostics) {
      diagnostics.integrityGateOutcome = "cached";
    }
    return false;
  }
  setSqliteBusyTimeout(database, OPENCLAW_SQLITE_BUSY_TIMEOUT_MS);
  const userVersion =
    getAdmittedSqliteSchemaFacts(database)?.userVersion ?? readSqliteUserVersion(database);
  const hasApplicationSchema = userVersion === 0 && hasAgentDatabaseApplicationSchema(database);
  const migrationPending =
    (userVersion === 0 && hasApplicationSchema) ||
    (userVersion > 0 && userVersion < OPENCLAW_AGENT_SCHEMA_VERSION);
  if (migrationPending) {
    agentDbLog.info("agent database schema migration pending; verifying integrity first", {
      fromVersion: userVersion,
      path: pathname,
      toVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
    });
  }
  const hasPendingCurrentVersionMigration =
    userVersion === OPENCLAW_AGENT_SCHEMA_VERSION &&
    hasPendingCurrentVersionAgentDatabaseMigration(database);
  const integrity = resolveSchemaMigrationIntegrityCheck(
    {
      kind: "agent",
      foundVersion: userVersion,
      supportedVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
    },
    integrityCheck,
  );
  const startedAt = performance.now();
  if (diagnostics?.integrityGateReason === "stale-lease-full" && diagnostics.because) {
    agentDbLog.info(
      `agent database integrityGateReason=stale-lease-full because=${diagnostics.because}`,
      {
        agentId,
        path: pathname,
        ...diagnostics,
      },
    );
  }
  if (userVersion === OPENCLAW_AGENT_SCHEMA_VERSION && !hasPendingCurrentVersionMigration) {
    if (
      !verification &&
      !reuseRuntimeIntegrity &&
      integrityCheck !== "full" &&
      admitAgentDatabaseStartupStructure(database, pathname, agentId, startupIntegrity, diagnostics)
    ) {
      return false;
    }
    const reuseIntegrity =
      reuseRuntimeIntegrity ||
      (verification !== undefined && !migrationPending && !hasPendingCurrentVersionMigration);
    const validateSchema = (readTable?: SqliteTableContractReader) =>
      assertOpenClawAgentCurrentRuntimeSchema(database, { agentId, pathname }, readTable);
    const rebuiltIndexes = yield* verifyAndRepairCanonicalSqliteIndexSteps(
      database,
      pathname,
      OPENCLAW_AGENT_SCHEMA_SQL,
      {
        allowMissingColumns: true,
        validateAfterRepair: validateSchema,
        validateUnchanged: validateSchema,
        diagnostics,
        reuseIntegrity,
        // Current-schema callbacks do not repeat historical migration table coverage.
        integrity: integrityCheck
          ? { ...integrity, tables: integrityTables ?? integrity.tables }
          : undefined,
      },
    );
    if (rebuiltIndexes.length > 0) {
      agentDbLog.warn(
        `Rebuilt canonical agent SQLite indexes for ${agentId} (${pathname}): ${rebuiltIndexes.join(", ")}`,
        {
          agentId,
          path: pathname,
          indexes: rebuiltIndexes,
          elapsedMs: Math.floor(performance.now() - startedAt),
        },
      );
    }
  } else if (
    userVersion === 0 &&
    !hasApplicationSchema &&
    database.prepare("PRAGMA page_count").get()?.page_count === 0
  ) {
    // Publish a fresh empty database's owner before another local caller resolves its store.
    // Yielding first leaves an occupied, unowned file that custom selectors must avoid.
    assertSqliteIntegrity(database, pathname, integrityCheck ? integrity : undefined);
  } else {
    // Pending migrations cannot inherit an earlier runtime verification.
    yield* sqliteIntegrityCheckSteps(database, pathname, diagnostics, integrity);
  }
  return hasPendingCurrentVersionMigration;
}

function migrateAgentStorageInTransaction(
  db: DatabaseSync,
  schemaSql: string,
  previousVersion: number,
  warnings: string[],
): void {
  maintenanceAuthority.renewAgentDatabaseMaintenanceAuthorityIfPresent();
  if (previousVersion === TRANSCRIPT_FTS_ROW_SCHEMA_VERSION) {
    migrateDeployedTranscriptFtsRowsInTransaction(db, schemaSql);
  } else if (
    db.prepare("SELECT 1 FROM sqlite_schema WHERE name = ?").get("session_transcript_fts_rows")
  ) {
    throw new Error(
      "Transcript FTS row map already exists before the schema-23 storage migration.",
    );
  }
  maintenanceAuthority.renewAgentDatabaseMaintenanceAuthorityIfPresent();
  migrateTranscriptPayloadStorageInTransaction(db, schemaSql);
  maintenanceAuthority.renewAgentDatabaseMaintenanceAuthorityIfPresent();
  migrateMemoryIndexStorage(db, {
    renewAuthority: maintenanceAuthority.renewAgentDatabaseMaintenanceAuthorityIfPresent,
    onWarning: (warning) => warnings.push(warning),
  });
  maintenanceAuthority.renewAgentDatabaseMaintenanceAuthorityIfPresent();
  migrateSessionCostUsageRollupStorage(
    db,
    maintenanceAuthority.renewAgentDatabaseMaintenanceAuthorityIfPresent,
  );
  maintenanceAuthority.renewAgentDatabaseMaintenanceAuthorityIfPresent();
  db.exec(schemaSql);
  // Keep native 64-bit rowids, duplicate message IDs and FTS tie ordering intact.
  if (previousVersion !== TRANSCRIPT_FTS_ROW_SCHEMA_VERSION) {
    db.exec(`
    INSERT INTO session_transcript_fts_rows (id, session_id, message_id)
    SELECT rowid, session_id, message_id FROM session_transcript_fts;
  `);
  }
}

type AgentSchemaMutationGuard = <T>(run: () => T) => T;

function ensureAgentSchema(
  db: DatabaseSync,
  agentId: string,
  pathname: string,
  targetVersion = OPENCLAW_AGENT_SCHEMA_VERSION,
  withCommit: AgentSchemaMutationGuard = (run) => run(),
  onMigrationWarning?: (warning: string) => void,
  versionMigrationOnly = false,
  integrityCheck?: "quick" | "full",
): void {
  const warnings: string[] = [];
  const schemaSql = getOpenClawAgentMigrationSchema(targetVersion);
  // FK enforcement must be off before BEGIN: PRAGMA foreign_keys is a silent
  // no-op inside a transaction, and legacy owner-table rebuilds would otherwise
  // cascade-delete their children. Steady-state enforcement is restored below.
  db.exec("PRAGMA foreign_keys = OFF; PRAGMA legacy_alter_table = OFF;");
  let created = false;
  try {
    const mutate = () => {
      // A competing initializer may claim an unowned file while BEGIN waits.
      // Read its authoritative owner and schema only after acquiring the writer lock.
      invalidateSqliteSchemaFacts(db);
      const metadata = readExistingAgentSchemaMeta(db);
      assertExistingAgentSchemaOwner(metadata, agentId, pathname);
      const previousVersion = assertSupportedAgentSchemaVersion(db, pathname);
      const integrity = resolveSchemaMigrationIntegrityCheck(
        { kind: "agent", foundVersion: previousVersion, supportedVersion: targetVersion },
        integrityCheck,
      );
      const isEmptyDatabase = previousVersion === 0 && !hasAgentDatabaseApplicationSchema(db);
      const schemaMigration =
        previousVersion < targetVersion && (previousVersion > 0 || metadata !== null);
      const identityMigration = targetVersion >= 18 && schemaMigration;
      if (identityMigration && metadata?.schemaVersion !== previousVersion) {
        throw new Error(
          `Agent schema markers disagree for ${pathname}; repair ownership metadata before migration.`,
        );
      }
      if (previousVersion > targetVersion) {
        throw new Error(
          `OpenClaw agent database ${pathname} uses schema version ${previousVersion}; expected at most ${targetVersion} for this migration.`,
        );
      }
      if (!isEmptyDatabase && previousVersion < targetVersion) {
        assertSupportedAgentMigrationSchemas(db, pathname, previousVersion);
      }
      const assertMigration = () => {
        if (!schemaMigration) {
          return;
        }
        if (identityMigration) {
          maintenanceLease.assertAgentDatabaseMaintenanceAuthority();
        }
        getOpenClawDatabaseMaintenanceScope()?.assertAgentSchemaMigration({
          agentId,
          path: pathname,
          foundVersion: previousVersion,
          supportedVersion: targetVersion,
        });
      };
      assertMigration();
      if (previousVersion < targetVersion) {
        interruptHistoricalPendingInputs(db, previousVersion);
      }
      if (isEmptyDatabase && targetVersion === OPENCLAW_AGENT_SCHEMA_VERSION) {
        // Canonical creation has no legacy rows or definitions to converge or repair.
        db.exec(schemaSql);
        db.exec(`PRAGMA user_version = ${targetVersion};`);
        persistAgentSchemaMetadata(db, agentId, targetVersion);
        created = true;
        return;
      }
      const crossesVersion = (version: number) =>
        !isEmptyDatabase && previousVersion < version && targetVersion >= version;
      const requiresCanonicalWriterMigration = crossesVersion(
        CANONICAL_SESSION_WRITER_VALIDATION_SCHEMA_VERSION,
      );
      const requiresStorageMigration = crossesVersion(AGENT_STORAGE_SCHEMA_VERSION);
      const requiresSnapshotMigration = crossesVersion(SESSION_ENTRY_SNAPSHOTS_SCHEMA_VERSION);
      const requiresTrajectoryMigration = crossesVersion(AGENT_TRAJECTORY_STORAGE_SCHEMA_VERSION);
      const trajectorySchemaSql = requiresTrajectoryMigration
        ? withoutTrajectoryPayloadColumns(schemaSql)
        : schemaSql;
      const storageSchemaSql = requiresSnapshotMigration
        ? withoutSessionEntrySnapshotsSchema(trajectorySchemaSql)
        : trajectorySchemaSql;
      const migrationSchemaSql = requiresStorageMigration
        ? withLegacyAgentStorageSchema(storageSchemaSql, previousVersion)
        : storageSchemaSql;
      const finishStorageMigration = () => {
        if (requiresStorageMigration) {
          migrateAgentStorageInTransaction(db, storageSchemaSql, previousVersion, warnings);
        }
        if (requiresSnapshotMigration) {
          migrateSessionEntrySnapshotsInTransaction(db);
        }
        if (requiresCanonicalWriterMigration) {
          migrateCanonicalSessionWriterValidation(db);
        }
        if (crossesVersion(AGENT_JSON_PREDICATE_SCHEMA_VERSION)) {
          migrateAgentJsonPredicatesInTransaction(db);
        }
        if (
          previousVersion < AGENT_OUTBOX_SEQUENCE_SCHEMA_VERSION &&
          targetVersion >= AGENT_OUTBOX_SEQUENCE_SCHEMA_VERSION
        ) {
          const elapsedMs = migrateOutboxEnqueueSequenceInTransaction(db);
          if (elapsedMs !== null) {
            agentDbLog.info("agent outbox enqueue sequence rebuilt", {
              agentId,
              pathname,
              elapsedMs,
            });
          }
        }
        if (crossesVersion(AGENT_WRITE_LAYOUT_SCHEMA_VERSION)) {
          migrateAgentWriteLayoutInTransaction(db);
        }
        if (crossesVersion(AGENT_INDEX_RETIREMENT_SCHEMA_VERSION)) {
          db.exec(AGENT_INDEX_RETIREMENT_SQL);
        }
        if (requiresTrajectoryMigration) {
          migrateAgentTrajectoryStorageInTransaction(db);
        }
        if (crossesVersion(AGENT_MEMORY_REVISION_SCHEMA_VERSION)) {
          db.exec(AGENT_MEMORY_REVISION_SQL);
        }
        if (crossesVersion(AGENT_COLD_ARCHIVE_CHUNKS_SCHEMA_VERSION)) {
          db.exec(AGENT_COLD_ARCHIVE_CHUNKS_SQL);
        }
        if (crossesVersion(AGENT_COLD_NAVIGATION_SCHEMA_VERSION)) {
          migrateAgentColdNavigationInTransaction(db);
        }
        // Historical rebuilds also converge indexes. Later version steps own
        // only their declared tables; additive index repair stays at admission.
        if (previousVersion < CANONICAL_SESSION_WRITER_VALIDATION_SCHEMA_VERSION) {
          repairCanonicalSqliteIndexes(db, pathname, schemaSql, {
            verifyPhysicalIntegrity: false,
            integrity,
          });
        }
        finishAgentSchemaMigration(
          db,
          agentId,
          pathname,
          targetVersion,
          schemaSql,
          identityMigration,
          assertMigration,
          schemaMigration
            ? resolveSchemaMigrationIntegrityTables({
                kind: "agent",
                foundVersion: previousVersion,
                supportedVersion: targetVersion,
              })
            : undefined,
        );
      };
      if (
        previousVersion >= CANONICAL_SESSION_WRITER_VALIDATION_SCHEMA_VERSION &&
        previousVersion < targetVersion
      ) {
        assertAgentSchemaVersion(
          db,
          { agentId, pathname, version: previousVersion },
          getOpenClawAgentMigrationSchema(previousVersion),
        );
        // Schema-25 writers predate later startup columns; read-only session
        // readers refuse a migrated database that still lacks them.
        if (!versionMigrationOnly) {
          ensureSessionAdditiveColumns(db);
        }
        finishStorageMigration();
        return;
      }
      if (
        previousVersion < targetVersion &&
        previousVersion >= CANONICAL_SESSION_VALIDATION_SCHEMA_VERSION - 1 &&
        previousVersion < CANONICAL_SESSION_WRITER_VALIDATION_SCHEMA_VERSION &&
        targetVersion >= CANONICAL_SESSION_VALIDATION_SCHEMA_VERSION
      ) {
        if (previousVersion >= CANONICAL_SESSION_VALIDATION_SCHEMA_VERSION) {
          // Keep schema-21's admitted additive repairs before its exact-shape
          // preflight; the storage cutover must not retire those upgrade paths.
          migrateRetiredAgentStateLeaseSchema(db, pathname, targetVersion);
          ensureSessionAdditiveColumns(db);
          ensureSessionEntryValidityProjection(db);
          ensureLegacySessionEntryValidityTriggers(db);
          ensureSessionKeyContractSchemaInTransaction(db);
          if (hasPendingMemoryChunkMetadataMigration(db)) {
            migrateMemoryChunkMetadataSchema(db);
          }
        }
        const previousSchema = getOpenClawAgentMigrationSchema(previousVersion);
        repairCanonicalSqliteIndexes(db, pathname, previousSchema, {
          verifyPhysicalIntegrity: false,
          integrity,
        });
        assertAgentSchemaVersion(
          db,
          { agentId, pathname, version: previousVersion },
          previousSchema,
        );
        if (previousVersion < CANONICAL_SESSION_VALIDATION_SCHEMA_VERSION) {
          db.exec(canonicalSessionValidationSchemaSql(migrationSchemaSql));
          if (!requiresCanonicalWriterMigration) {
            seedCanonicalSessionValidationPending(db);
          }
        }
        finishStorageMigration();
        return;
      }
      if (previousVersion === AGENT_MEDIA_SCHEMA_VERSION) {
        ensureSessionAdditiveColumns(db);
        ensureLegacySessionEntryValidityTriggers(db);
        assertSqliteIntegrity(db, pathname, integrity);
        migrateMemoryChunkMetadataSchema(db);
        // Validate before CREATE IF NOT EXISTS can conceal missing required storage.
        // The finalizer repairs canonical indexes after the remaining migrations.
        assertOpenClawAgentSchemaContains(
          db,
          pathname,
          getOpenClawAgentMigrationSchema(previousVersion),
          "legacy",
          true,
        );
      }
      migrateRetiredAgentStateLeaseSchema(db, pathname, targetVersion);
      if (previousVersion === targetVersion) {
        ensureSessionAdditiveColumns(db);
        ensureSessionEntryValidityProjection(db);
        ensureSessionKeyContractSchemaInTransaction(db);
        ensureSessionReactionsSchemaInTransaction(db);
        if (hasPendingMemoryChunkMetadataMigration(db)) {
          migrateMemoryChunkMetadataSchema(db);
          db.exec(schemaSql);
        }
        // Repair canonical indexes after the same-version additive schema changes.
        repairCanonicalSqliteIndexes(db, pathname, schemaSql, {
          verifyPhysicalIntegrity: false,
          integrity: integrityCheck ? integrity : undefined,
        });
        persistAgentSchemaMetadata(db, agentId, targetVersion);
        assertAgentSchemaVersion(db, { agentId, pathname, version: targetVersion }, schemaSql);
        maintenanceAuthority.assertAgentDatabaseMaintenanceAuthorityIfPresent();
        return;
      } else if (previousVersion === 14) {
        repairAndAssertOpenClawAgentV14SchemaForMigration(db, { agentId, pathname });
      }
      maintenanceAuthority.renewAgentDatabaseMaintenanceAuthorityIfPresent();
      migrateMemoryIndexSourcesIdentity(db);
      migrateOpenClawAgentSchema(db);
      migrateConversationDeliveryTargetColumn(db);
      if (previousVersion < 11) {
        backfillSessionConversations(db);
      }
      migrateSessionNodesAndWindows(db, previousVersion);
      maintenanceAuthority.renewAgentDatabaseMaintenanceAuthorityIfPresent();
      ensureSessionAdditiveColumns(db);
      if (targetVersion >= 18 && previousVersion < 18) {
        migrateSessionParticipantsSchema(db, pathname);
      }
      if (targetVersion >= 19) {
        migrateSessionCreatorNamespaces(db, previousVersion);
      }
      // Creator migration rewrites entry_json and invalidates its stored validity.
      ensureSessionEntryValidityProjection(db);
      maintenanceAuthority.renewAgentDatabaseMaintenanceAuthorityIfPresent();
      db.exec(migrationSchemaSql);
      if (previousVersion !== AGENT_MEDIA_SCHEMA_VERSION) {
        migrateMemoryChunkMetadataSchema(db);
      }
      if (previousVersion < targetVersion) {
        ensureOpenClawAgentBoardSchemaInTransaction(db);
      }
      migrateSessionTranscriptGenerations(db, previousVersion);
      migrateSessionTranscriptActiveProjection(db, previousVersion);
      if (previousVersion < 11) {
        migrateSqliteSchemaToStrictInTransaction(db, migrationSchemaSql, {
          databaseLabel: pathname,
          integrityCheck,
        });
      }
      if (
        previousVersion < CANONICAL_SESSION_VALIDATION_SCHEMA_VERSION &&
        targetVersion >= CANONICAL_SESSION_VALIDATION_SCHEMA_VERSION &&
        !requiresCanonicalWriterMigration
      ) {
        seedCanonicalSessionValidationPending(db);
      }
      finishStorageMigration();
    };
    runSqliteImmediateTransactionSync(db, mutate, {
      databaseLabel: pathname,
      operationLabel: "agent.schema.ensure",
      withCommit,
    });
  } finally {
    if (db.isOpen) {
      db.exec("PRAGMA foreign_keys = ON;");
    }
  }
  if (created && (isSqliteSchemaAdmissionCold(db) || getAdmittedSqliteSchemaFacts(db))) {
    // Tracked handles retain creator facts; DDL and transaction rollback invalidate them.
    admitSqliteSchema(db);
    adoptCanonicalSessionValidationSchema(db);
  }
  for (const warning of warnings) {
    const message = `Agent ${agentId}: ${warning}`;
    agentDbLog.warn(message);
    onMigrationWarning?.(message);
  }
}

/** Initialize agent schema/ownership metadata on an independently managed connection. */
export function ensureOpenClawAgentDatabaseSchema(
  db: DatabaseSync,
  options: OpenClawAgentDatabaseOptions & {
    register?: boolean;
    integrityCheck?: "quick" | "full";
  },
): void {
  runSqliteIntegrityOperationSync(ensureOpenClawAgentDatabaseSchemaSteps(db, options));
}

/** Share one schema sequence between synchronous callers and leased maintenance. */
export function* ensureOpenClawAgentDatabaseSchemaSteps(
  db: DatabaseSync,
  options: OpenClawAgentDatabaseOptions & {
    register?: boolean;
    onMigrationWarning?: (warning: string) => void;
    /** Finish only the declared version step; ordinary admission owns additive repairs. */
    versionMigrationOnly?: boolean;
    integrityCheck?: "quick" | "full";
  },
): SqliteIntegrityOperation<void> {
  const agentId = normalizeAgentId(options.agentId);
  const databaseOptions = { ...options, agentId };
  // The opened file owns its identity; lexical resolution can change a symlink/.. locator.
  const pathname = db.location() ?? resolveOpenClawAgentSqlitePath(databaseOptions);
  // The version prelude already revoked and verified this source under the same custody.
  if (!options.versionMigrationOnly) {
    revokeSqliteDatabaseAdmissions(db);
  }
  assertExistingAgentSchemaOwner(readExistingAgentSchemaMeta(db), agentId, pathname);
  const version = assertSupportedAgentSchemaVersion(db, pathname);
  if (version < OPENCLAW_AGENT_SCHEMA_VERSION) {
    assertSupportedAgentMigrationSchemas(db, pathname, version);
  }
  const deletionFence =
    databaseOptions.register === true &&
    isPersistentOpenClawAgentDatabasePath(pathname, databaseOptions.env)
      ? agentDeletion.prepareAgentDeletionPathFence(
          { agentId, path: pathname },
          { env: databaseOptions.env },
          "maintenance",
        )
      : undefined;
  const withRegistrationFence = <T>(run: () => T): T => {
    if (!deletionFence) {
      return run();
    }
    return runOpenClawStateWriteTransaction(
      (database) => {
        const leaseFence = maintenanceLease.agentDatabaseMaintenanceAuthority
          .getStore()
          ?.authority.holdWriteFence?.(database.db);
        assertAgentDeletionRecoveryAllowsMutation(database, pathname);
        agentDeletion.assertAgentDeletionPathFence(database, deletionFence);
        const result = run();
        const warning = leaseFence?.renew();
        if (warning) {
          const message = `Agent ${agentId}: ${warning}`;
          agentDbLog.warn(message);
          options.onMigrationWarning?.(message);
        }
        return result;
      },
      { env: databaseOptions.env, initializationAgentPaths: [pathname] },
    );
  };
  // Check admission now; hold shared state only for commit so maintenance heartbeats can run.
  withRegistrationFence(() => undefined);
  if (db.location() && !options.versionMigrationOnly) {
    maintenanceAuthority.invalidateOpenClawAgentDatabaseIntegrityBeforeMutation(pathname);
  }
  ensureOpenClawAgentDatabasePermissions(pathname, databaseOptions);
  setSqliteBusyTimeout(db, OPENCLAW_SQLITE_BUSY_TIMEOUT_MS);
  assertSupportedAgentSchemaVersion(db, pathname);
  assertExistingAgentSchemaOwner(readExistingAgentSchemaMeta(db), agentId, pathname);
  const withIntegrityMutation: AgentSchemaMutationGuard = (run) =>
    deletionFence
      ? runSqliteImmediateTransactionSync(db, run, {
          databaseLabel: pathname,
          operationLabel: "agent.schema.integrity",
          withCommit: withRegistrationFence,
        })
      : run();
  // The version-phase owner admitted every selected database before its scoped
  // checkpoint, under the same Doctor custody retained through this write.
  if (!options.versionMigrationOnly && readSqliteUserVersion(db) !== AGENT_MEDIA_SCHEMA_VERSION) {
    const integrity = agentDatabaseIntegrityBeforeMutationSteps(
      db,
      agentId,
      pathname,
      undefined,
      undefined,
      false,
      false,
      options.integrityCheck,
    );
    try {
      let step = withIntegrityMutation(() => integrity.next());
      while (!step.done) {
        let failure: { error: unknown } | undefined;
        try {
          yield step.value;
        } catch (error) {
          failure = { error };
        }
        // Resuming integrity can repair indexes before the outer schema phase runs.
        step = withIntegrityMutation(() =>
          failure ? integrity.throw(failure.error) : integrity.next(),
        );
      }
    } finally {
      integrity.return(false);
    }
  }
  configureSqlitePreSchemaPragmas(db, { busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS });
  ensureAgentSchema(
    db,
    agentId,
    pathname,
    OPENCLAW_AGENT_SCHEMA_VERSION,
    withRegistrationFence,
    options.onMigrationWarning,
    options.versionMigrationOnly,
    options.integrityCheck,
  );
  if (options.versionMigrationOnly) {
    return;
  }
  ensureOpenClawAgentDatabasePermissions(pathname, databaseOptions);
  const admittedDb = admitOpenClawAgentDatabaseSchema(db, { agentId, path: pathname });
  if (databaseOptions.register === true) {
    registerOpenClawAgentDatabase({ agentId, path: pathname, env: options.env, admittedDb });
  }
}

export { ensureAgentSchema as ensureOpenClawAgentSchema };
