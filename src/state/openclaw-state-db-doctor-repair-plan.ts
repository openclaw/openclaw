import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { decideDoctorPendingFromLiveStores } from "../commands/doctor-live-store-pending.js";
import type { DoctorMaintenancePending } from "../commands/doctor-maintenance-pending.js";
import { resolveClientCredentialStorePath } from "../infra/client-credential-paths.js";
import { hasClientCredentialStoreRecoveryWork } from "../infra/client-credential-recovery-plan.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { findCanonicalSqliteIndexDrift } from "../infra/sqlite-index-schema.js";
import {
  assertSqliteSchemaTablesPresent,
  collectSqliteSchemaIssues,
  createSqliteTableContractReader,
  getCanonicalSqliteTableNames,
} from "../infra/sqlite-schema-contract.js";
import { readMainTableList } from "../infra/sqlite-strict.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { hasLegacyCronRunLogs } from "../infra/state-legacy-cron-presence.js";
import { hasPreJournalStateSchema } from "./agent-deletion-journal-history.js";
import { hasOpenClawDatabaseQuarantineClearWork } from "./openclaw-quarantine-store.js";
import { CLAW_FIRST_USE_ADDITIVE_STATE_COLUMN_DEFINITIONS } from "./openclaw-state-db-additive-columns.js";
import { hasCanonicalAuditEventsSchema } from "./openclaw-state-db-audit-migration.js";
import {
  DOCTOR_OWNED_STATE_TABLES,
  LAZY_ADDITIVE_STATE_TABLES,
  OPENCLAW_STATE_SCHEMA_VERSION,
} from "./openclaw-state-db-contract.js";
import { hasDanglingSkillWorkshopCollectionReviewIndex } from "./openclaw-state-db-doctor-schema.js";
import { isStatePostgres } from "./openclaw-state-db-engine.js";
import { assertCurrentStateRuntimeSchema } from "./openclaw-state-db-fast-path.js";
import { hasHistoricalImageReserveSnapshots } from "./openclaw-state-db-image-snapshot-migration.js";
import {
  hasAcpReplayEstimatedBytesWork,
  hasCronJobProjectionWork,
  hasDeliveryQueueBackfillWork,
  hasLegacySubagentExecutionPayloadWork,
  hasLegacySubagentRetainedResultWork,
  hasOperatorApprovalResolutionRefWork,
} from "./openclaw-state-db-legacy-backfills.js";
import { detectOperatorApprovalSchemaMigration } from "./openclaw-state-db-operator-approval-migration.js";
import { hasOpenClawStatePermissionDrift } from "./openclaw-state-db-permissions.js";
import {
  classifyStateDatabaseIntegrity,
  hasRecordedStateDatabaseDamage,
} from "./openclaw-state-db-repair-pending.js";
import { hasAdditiveStateSchemaRepairWork } from "./openclaw-state-db-schema-additive.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import {
  assertCanonicalAgentDatabasesPrimaryKey,
  assertCanonicalStateSchemaShape,
  LEGACY_STATE_TABLES,
} from "./openclaw-state-db-schema-repair.js";
import { needsPublicationDraftMigration } from "./openclaw-state-db-schema-v28-publication.js";
import { readStateSchemaContentVersion } from "./openclaw-state-db-schema-version.js";
import { needsSessionWatchCursorProvenanceMigration } from "./openclaw-state-db-session-watch-migration.js";
import { hasOrphanTaskDeliveryRows } from "./openclaw-state-db-task-delivery-recovery-preservation.js";
import { resolveDatabasePath, resolveQuarantineStorePath } from "./openclaw-state-db.paths.js";
import { hasCurrentStateSchemaVersionWork } from "./openclaw-state-schema-publication.js";
import { getOpenClawStateRuntimeSchema } from "./openclaw-state-schema-runtime.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";
import { resolveSchemaMigrationIntegrityCheck } from "./schema-migration-backup-scope.js";

type PlanRead = {
  db: DatabaseSync;
  pathname: string;
  env: NodeJS.ProcessEnv;
  integrityCheck: "quick" | "full";
  now: number;
};

/** True when the guarded assertion refuses, which the repair reports as a warning. */
function refuses(assertion: () => void): boolean {
  try {
    assertion();
    return false;
  } catch {
    return true;
  }
}

/**
 * Every condition doctor-scope `repairStateSchemaAsync` (openclaw-state-db-repair.ts) acts on
 * for a store at the current schema version, in repair order. Each answers from the rows or
 * catalog entries its step writes; a refusal (a warning from the repair) counts as work.
 * The version-gated steps (text normalization, bounded and historical migrations, table
 * retirements, the v8/v9/v12/v21 repairs and every versioned migration but publication drafts)
 * act only below the current version, which `schema-version` decides.
 * A same-version write added to the repair needs a condition here.
 */
const STATE_SCHEMA_REPAIR_CONDITIONS: ReadonlyArray<{
  id: string;
  work(read: PlanRead): boolean;
}> = [
  // assertCanonicalAgentDatabasesPrimaryKey before any write.
  {
    id: "registry-key",
    work: ({ db, pathname }) =>
      refuses(() => assertCanonicalAgentDatabasesPrimaryKey(db, pathname)),
  },
  // normalizeSqliteText, bounded migrations and markCurrentStateSchemaVersion.
  {
    id: "schema-version",
    work: ({ db }) =>
      readSqliteUserVersion(db) !== OPENCLAW_STATE_SCHEMA_VERSION ||
      readStateSchemaContentVersion(db) !== OPENCLAW_STATE_SCHEMA_VERSION ||
      hasCurrentStateSchemaVersionWork(db),
  },
  // classifyStateDatabaseIntegrity: index scan, orphan foreign keys, or the integrity refusal.
  {
    id: "integrity",
    work: ({ db, pathname, integrityCheck }) =>
      classifyStateDatabaseIntegrity(
        db,
        pathname,
        resolveSchemaMigrationIntegrityCheck(
          {
            kind: "state",
            foundVersion: OPENCLAW_STATE_SCHEMA_VERSION,
            supportedVersion: OPENCLAW_STATE_SCHEMA_VERSION,
          },
          integrityCheck,
        ),
      ) !== "verified",
  },
  // clearOpenClawDatabaseQuarantine after the repair commits.
  {
    id: "quarantine-store",
    work: ({ pathname, env }) => hasOpenClawDatabaseQuarantineClearWork(pathname, env),
  },
  // recoverOrphanTaskDeliveryRows.
  { id: "orphan-task-delivery", work: ({ db }) => hasOrphanTaskDeliveryRows(db) },
  // prepareClientCredentialMigration and recoverClientCredentialStore.
  {
    id: "client-credentials",
    work: ({ db, pathname, env }) =>
      hasClientCredentialStoreRecoveryWork(db, { path: pathname, env }),
  },
  // migrateHistoricalStateImports(…, "doctor").
  { id: "historical-image-snapshots", work: ({ db }) => hasHistoricalImageReserveSnapshots(db) },
  // assertSqliteSchemaTablesPresent.
  {
    id: "required-tables",
    work: ({ db, pathname }) =>
      refuses(() =>
        assertSqliteSchemaTablesPresent(db, pathname, OPENCLAW_STATE_SCHEMA_SQL, {
          allowedMissingTables: [...LAZY_ADDITIVE_STATE_TABLES, ...DOCTOR_OWNED_STATE_TABLES],
        }),
      ),
  },
  // dropLegacyStateTables.
  {
    id: "legacy-tables",
    work: ({ db }) => LEGACY_STATE_TABLES.some((table) => tableExists(db, table)),
  },
  // repairAuditEventsSchema, repairOperatorApprovalSchema, assertCanonicalStateSchemaShape.
  {
    id: "audit-and-approval-schema",
    work: ({ db, pathname }) =>
      !hasCanonicalAuditEventsSchema(db) ||
      detectOperatorApprovalSchemaMigration(db, pathname).length > 0 ||
      refuses(() => assertCanonicalStateSchemaShape(db, pathname)),
  },
  // migrateSessionWatchCursorProvenance.
  {
    id: "session-watch",
    work: ({ db }) => needsSessionWatchCursorProvenanceMigration(db, OPENCLAW_STATE_SCHEMA_VERSION),
  },
  // statePublicationDraftMigration, the one versioned migration that is not version-gated.
  { id: "publication-drafts", work: ({ db }) => needsPublicationDraftMigration(db) },
  // ensureAdditiveStateColumns(…, "repair"): catalog changes, then each row backfill.
  { id: "additive-schema", work: ({ db }) => hasAdditiveStateSchemaRepairWork(db) },
  { id: "acp-replay-accounting", work: ({ db }) => hasAcpReplayEstimatedBytesWork(db) },
  { id: "cron-job-projection", work: ({ db }) => hasCronJobProjectionWork(db) },
  { id: "delivery-queue", work: ({ db, now }) => hasDeliveryQueueBackfillWork(db, now) },
  {
    id: "subagent-runs",
    work: ({ db }) =>
      hasLegacySubagentExecutionPayloadWork(db) || hasLegacySubagentRetainedResultWork(db),
  },
  { id: "operator-approval-refs", work: ({ db }) => hasOperatorApprovalResolutionRefWork(db) },
  // backfillCronRunLogEntryJson and migrateLegacyCronRunLogsToTaskRuns act only on this table.
  { id: "legacy-cron-run-logs", work: ({ db }) => hasLegacyCronRunLogs(db) },
  // executeCanonicalStateSchema and the STRICT rebuild: every runtime object, canonical.
  {
    id: "canonical-catalog",
    work: ({ db }) => {
      const runtimeSchema = getOpenClawStateRuntimeSchema({
        includeVersionLazyAdditiveTables: false,
        includeAgentDeletionJournal: true,
      });
      const tables = new Map(readMainTableList(db).map((row) => [row.name, row]));
      const journalOptional = !hasPreJournalStateSchema(db);
      return (
        getCanonicalSqliteTableNames(runtimeSchema).some((name) => {
          const table = tables.get(name);
          return table
            ? Number(table.strict) !== 1
            : !(journalOptional && DOCTOR_OWNED_STATE_TABLES.some((owned) => owned === name));
        }) ||
        collectSqliteSchemaIssues(db, OPENCLAW_STATE_SCHEMA_SQL, {
          allowedMissingTables: [
            ...LAZY_ADDITIVE_STATE_TABLES,
            ...(journalOptional ? DOCTOR_OWNED_STATE_TABLES : []),
          ],
          allowedMissingColumns: CLAW_FIRST_USE_ADDITIVE_STATE_COLUMN_DEFINITIONS.map(
            ({ tableName, columnName }) => `${tableName}.${columnName}`,
          ),
        }).length > 0
      );
    },
  },
  // repairCanonicalSqliteIndexes rebuilds this drift set, and refuses an unexpected unique index.
  {
    id: "canonical-indexes",
    work: ({ db, pathname }) => {
      let drifted = false;
      const refused = refuses(() => {
        drifted =
          findCanonicalSqliteIndexDrift(
            OPENCLAW_STATE_SCHEMA_SQL,
            pathname,
            createSqliteTableContractReader(db),
          ).length > 0;
      });
      return refused || drifted;
    },
  },
  // assertCurrentStateRuntimeSchema before commit.
  {
    id: "runtime-schema",
    work: ({ db, pathname }) => refuses(() => assertCurrentStateRuntimeSchema(db, pathname)),
  },
];

export type OpenClawStateSchemaRepairPlan = {
  decision: DoctorMaintenancePending;
  /** Each condition read before the decision; a decision made before opening reads fewer. */
  conditions: Readonly<Record<string, DoctorMaintenancePending>>;
};

/**
 * Read-only plan for Doctor's shared-state schema repair (`prepareOpenClawStateDatabaseSchema`
 * in doctor mode): "none" only when every condition the repair acts on answers none.
 *
 * It reads the live store through {@link decideDoctorPendingFromLiveStores}, so it never
 * copies, opens for writing, takes the schema lease or begins a write transaction, and it is
 * "undecidable" for a store nobody holds open, under an updater's capture, and on PostgreSQL.
 * The integrity check is run fresh, as the repair does.
 */
export async function planOpenClawStateDatabaseDoctorRepair(
  options: Parameters<typeof planRepair>[0],
): Promise<OpenClawStateSchemaRepairPlan> {
  try {
    return await planRepair(options);
  } catch {
    // A failed check (an unreadable file, an unexpected stat error) leaves the repair to run.
    return { decision: "undecidable", conditions: {} };
  }
}

async function planRepair(options: {
  env: NodeJS.ProcessEnv;
  integrityCheck?: "quick" | "full";
  now?: number;
}): Promise<OpenClawStateSchemaRepairPlan> {
  if (isStatePostgres()) {
    return { decision: "undecidable", conditions: {} };
  }
  const env = options.env;
  const pathname = resolveDatabasePath({ env });
  if (!existsSync(pathname)) {
    return { decision: "none", conditions: {} };
  }
  // Opening a store whose file mode drifted re-modes its WAL, so drift decides before any open.
  if (hasOpenClawStatePermissionDrift(pathname, env)) {
    return { decision: "work", conditions: { permissions: "work" } };
  }
  const conditions: Record<string, DoctorMaintenancePending> = { permissions: "none" };
  const decision = await decideDoctorPendingFromLiveStores(
    [pathname, resolveQuarantineStorePath(env), resolveClientCredentialStorePath(env)],
    () => {
      conditions["recorded-damage"] = hasRecordedStateDatabaseDamage(pathname, env)
        ? "work"
        : "none";
      using db = openNodeSqliteDatabase(pathname, { readOnly: true });
      // The dangling index makes ordinary catalog reads fail, so nothing else is decidable.
      if (hasDanglingSkillWorkshopCollectionReviewIndex(db)) {
        conditions["catalog-readability"] = "work";
        return "work";
      }
      conditions["catalog-readability"] = "none";
      const read: PlanRead = {
        db,
        pathname,
        env,
        integrityCheck: options.integrityCheck ?? "quick",
        now: options.now ?? Date.now(),
      };
      for (const condition of STATE_SCHEMA_REPAIR_CONDITIONS) {
        try {
          conditions[condition.id] = condition.work(read) ? "work" : "none";
        } catch {
          conditions[condition.id] = "undecidable";
        }
      }
      const answers = Object.values(conditions);
      return answers.includes("undecidable")
        ? "undecidable"
        : answers.includes("work")
          ? "work"
          : "none";
    },
  );
  return { decision, conditions };
}
