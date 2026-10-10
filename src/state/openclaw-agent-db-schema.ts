import type { DatabaseSync } from "node:sqlite";
import {
  ensureMemoryChunkProvenance,
  ensureMemoryRecallMetadataSchema,
  migrateMemoryIndexSourcesIdentity,
  migrateMemoryIndexStorage,
} from "../../packages/memory-host-sdk/src/host/memory-schema.js";
import { migrateSessionCostUsageRollupStorage } from "../infra/session-cost-usage-cache-migration.js";
import { revokeSqliteDatabaseAdmissions } from "../infra/sqlite-database-admission.js";
import {
  repairCanonicalSqliteIndexes,
  verifyAndRepairCanonicalSqliteIndexSteps,
} from "../infra/sqlite-index-schema.js";
import {
  assertSqliteIntegrity,
  sqliteWalAdmissionRefusal,
  runSqliteIntegrityOperationSync,
  sqliteIntegrityCheckSteps,
  type SqliteIntegrityDiagnostics,
  type SqliteIntegrityOperation,
} from "../infra/sqlite-integrity.js";
import { runSqliteSchemaReadSnapshotSync } from "../infra/sqlite-pinned-read-snapshot.js";
import {
  admitSqliteSchema,
  getAdmittedSqliteSchemaFacts,
  isSqliteSchemaAdmissionCold,
  runSqliteReadOperationSync,
} from "../infra/sqlite-schema-facts.js";
import { migrateSqliteSchemaToStrictInTransaction } from "../infra/sqlite-strict.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { configureSqlitePreSchemaPragmas } from "../infra/sqlite-wal.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { assertAgentDeletionRecoveryAllowsMutation } from "./agent-deletion-journal-recovery.js";
import {
  assertAgentDeletionPathFence,
  prepareAgentDeletionPathFence,
} from "./agent-deletion-journal.js";
import { ensureOpenClawAgentBoardSchemaInTransaction } from "./openclaw-agent-board-schema.js";
import {
  ensureLegacySessionEntryValidityTriggers,
  migrateCanonicalSessionWriterValidation,
} from "./openclaw-agent-canonical-validation-migration.js";
import {
  canonicalSessionValidationSchemaSql,
  assertCanonicalSessionValidationSchema,
} from "./openclaw-agent-canonical-validation-schema.js";
import {
  AGENT_MEDIA_SCHEMA_VERSION,
  AGENT_STORAGE_SCHEMA_VERSION,
  CANONICAL_SESSION_VALIDATION_SCHEMA_VERSION,
  CANONICAL_SESSION_WRITER_VALIDATION_SCHEMA_VERSION,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  TRANSCRIPT_FTS_ROW_SCHEMA_VERSION,
  type OpenClawAgentDatabaseOptions,
  type OpenClawAgentDatabase,
} from "./openclaw-agent-db-contract.js";
import { registerOpenClawAgentDatabaseIdentity } from "./openclaw-agent-db-identity.js";
import * as maintenanceAuthority from "./openclaw-agent-db-lease.js";
import { migrateOpenClawAgentSchema } from "./openclaw-agent-db-legacy-schema.js";
import { persistAgentSchemaMetadata } from "./openclaw-agent-db-metadata-write.js";
import { ensureOpenClawAgentDatabasePermissions } from "./openclaw-agent-db-permissions.js";
import { registerOpenClawAgentDatabase } from "./openclaw-agent-db-registry.js";
import {
  getOpenClawAgentMigrationSchema,
  assertExistingAgentSchemaOwner,
  assertCurrentAgentSchemaMetadata,
  assertOpenClawAgentCurrentRuntimeSchema,
  assertOpenClawAgentSchemaContains,
  assertSupportedAgentSchemaVersion,
  assertCanonicalAgentPersistenceVersion,
  assertAgentSchemaVersion,
  hasPendingCurrentVersionAgentDatabaseMigration,
  hasPendingMemoryChunkMetadataMigration,
  migrateRetiredAgentStateLeaseSchema,
  ensureSessionKeyContractSchemaInTransaction,
  ensureSessionReactionsSchemaInTransaction,
  readExistingAgentSchemaMeta,
  repairAndAssertOpenClawAgentV14SchemaForMigration,
} from "./openclaw-agent-db-schema-helpers.js";
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
  adoptOpenClawAgentDatabaseSchema,
  getOpenClawAgentDatabaseValidation,
  invalidateOpenClawAgentDatabaseSchema,
  invalidateOpenClawAgentDatabaseValidation,
  publishOpenClawAgentDatabaseSchema,
  setOpenClawAgentDatabaseValidation,
} from "./openclaw-agent-db-validation-cache.js";
import {
  isPersistentOpenClawAgentDatabasePath,
  resolveOpenClawAgentSqlitePath,
} from "./openclaw-agent-db.paths.js";
import { migrateSessionParticipantsSchema } from "./openclaw-agent-participants-migration.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import { migrateSessionEntrySnapshotsInTransaction } from "./openclaw-agent-session-snapshots-migration.js";
import {
  SESSION_ENTRY_SNAPSHOTS_SCHEMA_VERSION,
  withoutSessionEntrySnapshotsSchema,
} from "./openclaw-agent-session-snapshots-schema.js";
import { withLegacyAgentStorageSchema } from "./openclaw-agent-storage-schema.js";
import { migrateDeployedTranscriptFtsRowsInTransaction } from "./openclaw-agent-transcript-fts-schema.js";
import { migrateTranscriptPayloadStorageInTransaction } from "./openclaw-agent-transcript-payload-migration.js";
import {
  canReuseOpenClawAgentIntegrityVerification,
  type OpenClawAgentIntegrityVerification,
} from "./openclaw-quarantine-store.js";
import { getOpenClawDatabaseMaintenanceScope } from "./openclaw-state-db-async-lifecycle.js";
import {
  OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";

const agentDbLog = createSubsystemLogger("state/agent-db");

function migrateMemoryChunkMetadataSchema(db: DatabaseSync): void {
  ensureMemoryRecallMetadataSchema(db);
  ensureMemoryChunkProvenance(db);
}

export function* agentDatabaseIntegrityBeforeMutationSteps(
  database: DatabaseSync,
  agentId: string,
  pathname: string,
  diagnostics?: SqliteIntegrityDiagnostics,
  verification?: OpenClawAgentIntegrityVerification,
  reuseRuntimeIntegrity = false,
  processDeath = false,
  admittedSchema = false,
  deferUnverifiedIntegrity = false,
): SqliteIntegrityOperation<boolean> {
  if (reuseRuntimeIntegrity && admittedSchema) {
    if (diagnostics) {
      diagnostics.integrityGateOutcome = "cached";
    }
    return false;
  }
  database.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
  const userVersion = readSqliteUserVersion(database);
  const hasApplicationSchema = database
    .prepare("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1")
    .get();
  const migrationPending =
    (userVersion === 0 && hasApplicationSchema !== undefined) ||
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
  const startedAt = performance.now();
  const deferredReason = processDeath
    ? "process-death"
    : deferUnverifiedIntegrity && !verification && diagnostics?.integrityGateReason === "no-proof"
      ? "no-proof"
      : undefined;
  const deferredRefusal = deferredReason
    ? migrationPending || hasPendingCurrentVersionMigration
      ? "schema-migration-pending"
      : sqliteWalAdmissionRefusal(database, pathname)
    : undefined;
  if (deferredReason && diagnostics) {
    diagnostics.because = deferredRefusal;
  }
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
    const deferred = deferredReason !== undefined && !deferredRefusal;
    const reuseIntegrity =
      deferred ||
      reuseRuntimeIntegrity ||
      canReuseOpenClawAgentIntegrityVerification(
        pathname,
        verification,
        migrationPending || hasPendingCurrentVersionMigration,
      );
    const rebuiltIndexes = yield* verifyAndRepairCanonicalSqliteIndexSteps(
      database,
      pathname,
      OPENCLAW_AGENT_SCHEMA_SQL,
      {
        allowMissingColumns: true,
        validateAfterRepair: () =>
          assertOpenClawAgentCurrentRuntimeSchema(database, { agentId, pathname }),
        diagnostics,
        reuseIntegrity,
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
    assertOpenClawAgentCurrentRuntimeSchema(database, { agentId, pathname });
    if (deferred && diagnostics) {
      diagnostics.integrityGateReason = deferredReason;
      diagnostics.integrityGateMode = "deferred";
      diagnostics.integrityGateOutcome = "pending";
      diagnostics.because =
        deferredReason === "process-death"
          ? "same-boot-dead-owner-wal-recovered"
          : "native-wal-without-verification";
      diagnostics.integrityGateMs = Math.floor(performance.now() - startedAt);
    }
  } else if (
    userVersion === 0 &&
    !hasApplicationSchema &&
    database.prepare("PRAGMA page_count").get()?.page_count === 0
  ) {
    // Publish a fresh empty database's owner before another local caller resolves its store.
    // Yielding first leaves an occupied, unowned file that custom selectors must avoid.
    assertSqliteIntegrity(database, pathname);
  } else {
    // Pending migrations cannot inherit an earlier runtime verification.
    yield* sqliteIntegrityCheckSteps(database, pathname, diagnostics);
  }
  return hasPendingCurrentVersionMigration;
}

/** Re-admit the retained connection without replacing its native generation or lease. */
export function refreshOpenClawAgentDatabaseSchema(
  database: OpenClawAgentDatabase,
  assertCurrent: () => void,
) {
  const { db, agentId, path: pathname } = database;
  assertCurrent();
  if (db.isTransaction) {
    throw new Error("Agent schema admission requires a settled writer");
  }
  try {
    const reused = runSqliteReadOperationSync(db, () => {
      assertSupportedAgentSchemaVersion(db, pathname);
      assertCurrentAgentSchemaMetadata(readExistingAgentSchemaMeta(db), agentId, pathname);
      const validation = getOpenClawAgentDatabaseValidation(database);
      return validation && adoptOpenClawAgentDatabaseSchema(database) ? validation : undefined;
    });
    if (reused) {
      return reused;
    }
    const validation = getOpenClawAgentDatabaseValidation(database);
    invalidateOpenClawAgentDatabaseSchema(database);
    const convergence = runSqliteIntegrityOperationSync(
      agentDatabaseIntegrityBeforeMutationSteps(
        db,
        agentId,
        pathname,
        undefined,
        undefined,
        Boolean(validation),
      ),
      assertCurrent,
    );
    assertCanonicalAgentPersistenceVersion(db, pathname);
    if (convergence) {
      ensureAgentSchema(db, agentId, pathname);
    }
    // Publish facts from the same schema snapshot that passes the final contract checks.
    return runSqliteSchemaReadSnapshotSync(db, () => {
      admitSqliteSchema(db);
      assertOpenClawAgentCurrentRuntimeSchema(db, { agentId, pathname });
      assertCanonicalSessionValidationSchema(db);
      assertCurrent();
      if (!validation) {
        return setOpenClawAgentDatabaseValidation(database);
      }
      publishOpenClawAgentDatabaseSchema(database);
      return validation;
    });
  } catch (error) {
    invalidateOpenClawAgentDatabaseValidation(pathname);
    throw error;
  }
}

function seedCanonicalSessionValidationPending(db: DatabaseSync): void {
  // Migration records work only; the canonical owner validates and certifies row contents.
  db.exec(`
    INSERT INTO session_canonical_validation_pending (session_key)
    SELECT node.session_key FROM session_nodes AS node
    WHERE NOT EXISTS (
      SELECT 1 FROM session_canonical_validation_pending AS pending
      WHERE pending.session_key = node.session_key
    );
  `);
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
  migrateTranscriptPayloadStorageInTransaction(db);
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

function finishAgentSchemaMigration(
  db: DatabaseSync,
  agentId: string,
  pathname: string,
  targetVersion: number,
  schemaSql: string,
  requiresMaintenance: boolean,
  assertMigration: () => void,
): void {
  repairCanonicalSqliteIndexes(db, pathname, schemaSql, {
    verifyPhysicalIntegrity: false,
  });
  db.exec(`PRAGMA user_version = ${targetVersion};`);
  persistAgentSchemaMetadata(db, agentId, targetVersion);
  assertAgentSchemaVersion(db, { agentId, pathname, version: targetVersion }, schemaSql);
  if (requiresMaintenance && db.prepare("PRAGMA foreign_key_check").all().length > 0) {
    throw new Error(`Agent schema migration failed foreign key validation for ${pathname}.`);
  }
  assertMigration();
}

type AgentSchemaMutationGuard = <T>(run: () => T) => T;

function ensureAgentSchema(
  db: DatabaseSync,
  agentId: string,
  pathname: string,
  targetVersion = OPENCLAW_AGENT_SCHEMA_VERSION,
  withMutation: AgentSchemaMutationGuard = (run) => run(),
  onMigrationWarning?: (warning: string) => void,
): void {
  const warnings: string[] = [];
  const schemaSql = getOpenClawAgentMigrationSchema(targetVersion);
  const originalVersion = readSqliteUserVersion(db);
  const schemaMigration =
    originalVersion < targetVersion &&
    (originalVersion > 0 || readExistingAgentSchemaMeta(db) !== null);
  const identityMigration = targetVersion >= 18 && schemaMigration;
  const assertMigration = () => {
    if (!schemaMigration) {
      return;
    }
    if (identityMigration) {
      maintenanceAuthority.assertAgentDatabaseMaintenanceAuthority();
    }
    getOpenClawDatabaseMaintenanceScope()?.assertAgentSchemaMigration({
      agentId,
      path: pathname,
      foundVersion: originalVersion,
      supportedVersion: targetVersion,
    });
  };
  assertMigration();
  // FK enforcement must be off before BEGIN: PRAGMA foreign_keys is a silent
  // no-op inside a transaction, and legacy owner-table rebuilds would otherwise
  // cascade-delete their children. Steady-state enforcement is restored below.
  db.exec("PRAGMA foreign_keys = OFF; PRAGMA legacy_alter_table = OFF;");
  try {
    const mutate = () => {
      // Repeat preflight ownership/version gates inside the write transaction;
      // concurrent openers must not overwrite another agent after the scan.
      // Role/ownership gates before version: user_version is only meaningful
      // within one schema role, and the global state DB now carries version 3.
      assertExistingAgentSchemaOwner(readExistingAgentSchemaMeta(db), agentId, pathname);
      assertSupportedAgentSchemaVersion(db, pathname);
      const previousVersion = readSqliteUserVersion(db);
      if (identityMigration && readExistingAgentSchemaMeta(db)?.schemaVersion !== previousVersion) {
        throw new Error(
          `Agent schema markers disagree for ${pathname}; repair ownership metadata before migration.`,
        );
      }
      if (previousVersion > targetVersion) {
        throw new Error(
          `OpenClaw agent database ${pathname} uses schema version ${previousVersion}; expected at most ${targetVersion} for this migration.`,
        );
      }
      if (previousVersion < targetVersion) {
        assertSupportedAgentMigrationSchemas(db, pathname, previousVersion);
      }
      const isEmptyDatabase =
        previousVersion === 0 &&
        readExistingAgentSchemaMeta(db) === null &&
        !db.prepare("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get();
      const requiresCanonicalWriterMigration =
        !isEmptyDatabase &&
        previousVersion < CANONICAL_SESSION_WRITER_VALIDATION_SCHEMA_VERSION &&
        targetVersion >= CANONICAL_SESSION_WRITER_VALIDATION_SCHEMA_VERSION;
      const requiresStorageMigration =
        !isEmptyDatabase &&
        previousVersion < AGENT_STORAGE_SCHEMA_VERSION &&
        targetVersion >= AGENT_STORAGE_SCHEMA_VERSION;
      const requiresSnapshotMigration =
        !isEmptyDatabase &&
        previousVersion < SESSION_ENTRY_SNAPSHOTS_SCHEMA_VERSION &&
        targetVersion >= SESSION_ENTRY_SNAPSHOTS_SCHEMA_VERSION;
      const storageSchemaSql = requiresSnapshotMigration
        ? withoutSessionEntrySnapshotsSchema(schemaSql)
        : schemaSql;
      const migrationSchemaSql = requiresStorageMigration
        ? withLegacyAgentStorageSchema(storageSchemaSql, previousVersion)
        : storageSchemaSql;
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
        if (requiresStorageMigration) {
          migrateAgentStorageInTransaction(db, storageSchemaSql, previousVersion, warnings);
        }
        if (requiresSnapshotMigration) {
          migrateSessionEntrySnapshotsInTransaction(db);
        }
        if (requiresCanonicalWriterMigration) {
          migrateCanonicalSessionWriterValidation(db);
        }
        finishAgentSchemaMigration(
          db,
          agentId,
          pathname,
          targetVersion,
          schemaSql,
          identityMigration,
          assertMigration,
        );
        return;
      }
      if (previousVersion === AGENT_MEDIA_SCHEMA_VERSION) {
        ensureSessionAdditiveColumns(db);
        ensureLegacySessionEntryValidityTriggers(db);
        assertSqliteIntegrity(db, pathname);
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
        // Repeat index repair before the transactional schema assertion so a
        // concurrent opener cannot turn repairable drift into a hard refusal.
        repairCanonicalSqliteIndexes(db, pathname, schemaSql, {
          verifyPhysicalIntegrity: false,
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
        });
      }
      if (
        previousVersion < CANONICAL_SESSION_VALIDATION_SCHEMA_VERSION &&
        targetVersion >= CANONICAL_SESSION_VALIDATION_SCHEMA_VERSION &&
        !requiresCanonicalWriterMigration
      ) {
        seedCanonicalSessionValidationPending(db);
      }
      if (requiresStorageMigration) {
        migrateAgentStorageInTransaction(db, storageSchemaSql, previousVersion, warnings);
      }
      if (requiresSnapshotMigration) {
        migrateSessionEntrySnapshotsInTransaction(db);
      }
      if (requiresCanonicalWriterMigration) {
        migrateCanonicalSessionWriterValidation(db);
      }
      finishAgentSchemaMigration(
        db,
        agentId,
        pathname,
        targetVersion,
        schemaSql,
        identityMigration,
        assertMigration,
      );
    };
    runSqliteImmediateTransactionSync(db, () => withMutation(mutate), {
      databaseLabel: pathname,
      operationLabel: "agent.schema.ensure",
      withCommit: withMutation,
    });
  } finally {
    if (db.isOpen) {
      db.exec("PRAGMA foreign_keys = ON;");
    }
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
  options: OpenClawAgentDatabaseOptions & { register?: boolean },
): void {
  runSqliteIntegrityOperationSync(ensureOpenClawAgentDatabaseSchemaSteps(db, options));
}

/** Share one schema sequence between synchronous callers and leased maintenance. */
export function* ensureOpenClawAgentDatabaseSchemaSteps(
  db: DatabaseSync,
  options: OpenClawAgentDatabaseOptions & {
    register?: boolean;
    onMigrationWarning?: (warning: string) => void;
  },
): SqliteIntegrityOperation<void> {
  const agentId = normalizeAgentId(options.agentId);
  const databaseOptions = { ...options, agentId };
  const pathname = resolveOpenClawAgentSqlitePath(databaseOptions);
  // Explicit maintenance inspects current bytes even when this process previously admitted them.
  revokeSqliteDatabaseAdmissions(db);
  assertExistingAgentSchemaOwner(readExistingAgentSchemaMeta(db), agentId, pathname);
  const version = assertSupportedAgentSchemaVersion(db, pathname);
  if (version < OPENCLAW_AGENT_SCHEMA_VERSION) {
    assertSupportedAgentMigrationSchemas(db, pathname, version);
  }
  const deletionFence =
    databaseOptions.register === true &&
    isPersistentOpenClawAgentDatabasePath(pathname, databaseOptions.env)
      ? prepareAgentDeletionPathFence(
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
        assertAgentDeletionRecoveryAllowsMutation(database, pathname);
        assertAgentDeletionPathFence(database, deletionFence);
        return run();
      },
      { env: databaseOptions.env, initializationAgentPaths: [pathname] },
    );
  };
  // Validate history before touching an independent store, without holding shared -> agent locks.
  withRegistrationFence(() => undefined);
  if (db.location()) {
    maintenanceAuthority.invalidateOpenClawAgentDatabaseIntegrityBeforeMutation(
      pathname,
      databaseOptions.env,
    );
  }
  ensureOpenClawAgentDatabasePermissions(pathname, databaseOptions);
  db.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
  assertSupportedAgentSchemaVersion(db, pathname);
  assertExistingAgentSchemaOwner(readExistingAgentSchemaMeta(db), agentId, pathname);
  const withIntegrityMutation: AgentSchemaMutationGuard = (run) =>
    deletionFence
      ? runSqliteImmediateTransactionSync(db, () => withRegistrationFence(run), {
          databaseLabel: pathname,
          operationLabel: "agent.schema.integrity",
          withCommit: withRegistrationFence,
        })
      : run();
  if (readSqliteUserVersion(db) !== AGENT_MEDIA_SCHEMA_VERSION) {
    const integrity = agentDatabaseIntegrityBeforeMutationSteps(db, agentId, pathname);
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
  );
  ensureOpenClawAgentDatabasePermissions(pathname, databaseOptions);
  let admittedDb: DatabaseSync | undefined;
  if (db.location() && (isSqliteSchemaAdmissionCold(db) || getAdmittedSqliteSchemaFacts(db))) {
    admitSqliteSchema(db);
    assertCanonicalSessionValidationSchema(db);
    registerOpenClawAgentDatabaseIdentity(db);
    setOpenClawAgentDatabaseValidation({ db, path: pathname, agentId });
    admittedDb = db;
  }
  if (databaseOptions.register === true) {
    registerOpenClawAgentDatabase({
      agentId,
      path: pathname,
      env: databaseOptions.env,
      admittedDb,
    });
  }
}

export { ensureAgentSchema as ensureOpenClawAgentSchema };
