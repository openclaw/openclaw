import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import {
  ORDERED_STARTUP_ADDITIVE_STATE_COLUMNS as columns,
  CLAW_FIRST_USE_ADDITIVE_STATE_COLUMN_DEFINITIONS,
  CLAW_STARTUP_ADDITIVE_STATE_COLUMN_DEFINITIONS,
} from "./openclaw-state-db-additive-columns.js";
import {
  backfillAcpReplayEstimatedBytes,
  backfillCronJobsFromJobJson,
  backfillCronRunLogEntryJson,
  backfillDeliveryQueueEntriesFromEntryJson,
  ensureOperatorApprovalResolutionRefs,
  repairLegacyTaskAgentAttribution,
  repairLegacyTaskDeliveryStatuses,
  repairLegacySubagentExecutionPayloads,
  repairLegacySubagentRetainedResults,
  repairLegacySubagentSuspensionReasons,
  repairLegacySubagentTaskBindings,
} from "./openclaw-state-db-legacy-backfills.js";
import { ensureColumn, tableHasColumn } from "./openclaw-state-db-schema-helpers.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

const repositoryWorkspacePendingSchemas = new WeakSet<DatabaseSync>();

export function hasRepositoryWorkspacePendingResultSchema(database: DatabaseSync): boolean {
  if (repositoryWorkspacePendingSchemas.has(database)) {
    return true;
  }
  const exists = tableHasColumn(
    database,
    "worker_workspace_pending_results",
    "repository_workspace_id",
  );
  // Another process can create the column; cache only committed presence.
  // First-use DDL inside an outer transaction may still roll back.
  if (exists && !database.isTransaction) {
    repositoryWorkspacePendingSchemas.add(database);
  }
  return exists;
}

export function ensureRepositoryWorkspacePendingResultSchema(database: DatabaseSync): void {
  if (!hasRepositoryWorkspacePendingResultSchema(database)) {
    ensureColumn(database, "worker_workspace_pending_results", "repository_workspace_id TEXT");
  }
}

export function ensureSessionRepositoryWorkspaceSchema(database: DatabaseSync): void {
  database.exec(
    extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "session_repository_workspaces", {
      errorMessage: "Repository workspace schema marker is missing.",
    }),
  ); // sqlite-allow-raw -- Canonical first-use DDL; workspace rows use Kysely.
}

export function ensureRepositoryGitHubPublicationSchema(database: DatabaseSync): void {
  database.exec(
    extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "github_repository_publication_requests", {
      endMarker:
        "ON github_repository_publication_requests(owner_profile_id, session_id, idempotency_key) WHERE owner_profile_id IS NOT NULL;",
      errorMessage: "Repository GitHub publication schema marker is missing.",
    }),
  ); // sqlite-allow-raw -- Canonical first-use DDL; publication rows use Kysely.
}

export function ensureGitHubPublicationSessionLifecycleSchema(database: DatabaseSync): void {
  database.exec(
    extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "github_publication_session_lifecycles", {
      errorMessage: "GitHub publication lifecycle schema marker is missing.",
    }),
  ); // sqlite-allow-raw -- Canonical first-use DDL; bindings use Kysely.
}

/** Lazily install the additive secret store table and index on first write. */
export function ensureSecretStoreSchema(database: DatabaseSync): void {
  database.exec(
    extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "secret_store_entries", {
      endMarker:
        "ON secret_store_entries (scope_kind, scope_id, name) WHERE deleted_at_ms IS NULL;",
      errorMessage: "OpenClaw secret store schema marker is missing.",
    }),
  ); // sqlite-allow-raw -- Canonical additive DDL only.
  ensureColumn(database, "secret_store_entries", "allowed_hosts TEXT");
}

/** Lazily install durable MCP OAuth callback correlation on first feature use. */
export function ensureMcpOAuthPendingSchema(database: DatabaseSync): void {
  database.exec(
    extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "mcp_oauth_pending_authorizations", {
      errorMessage: "OpenClaw MCP OAuth pending schema marker is missing.",
    }),
  ); // sqlite-allow-raw -- Canonical additive DDL only.
}

/** Lazily install the additive device join-code table on first mint or redemption. */
export function ensureDevicePairingJoinCodeSchema(database: DatabaseSync): void {
  database.exec(
    extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "device_pairing_join_codes", {
      errorMessage: "OpenClaw device pairing join-code schema marker is missing.",
    }),
  ); // sqlite-allow-raw -- Canonical additive DDL only.
}

/** Lazily installs the Gateway's installation-local config revision key owner. */
export function ensureConfigRevisionKeySchema(database: DatabaseSync): void {
  database.exec(
    extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "config_revision_keys", {
      errorMessage: "OpenClaw config revision key schema marker is missing.",
    }),
  ); // sqlite-allow-raw -- Canonical additive DDL only; key rows use Kysely.
}

export function ensureAgentDeletionJournalSchema(database: DatabaseSync): void {
  database.exec(extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "agent_deletion_journal"));
}

export function ensureAgentDatabaseLeaseSchema(database: DatabaseSync): void {
  ensureAgentDeletionJournalSchema(database);
  database.exec(extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "agent_database_leases"));
}

/**
 * Same-version additive table, registered in LAZY_ADDITIVE_STATE_TABLES so
 * existing v6 databases stay valid without it. Uses the canonical schema;
 * a downgraded reader simply loses setup-completion reconciliation.
 */
export function ensureDevicePairSetupCompletionSchema(database: DatabaseSync): void {
  database.exec(
    extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "device_pair_setup_completions"),
  );
}

/** Lazily add setup correlation only when setup pairing first writes or consumes a token. */
export function ensureDevicePairSetupBootstrapSchema(database: DatabaseSync): void {
  ensureColumn(database, "device_bootstrap_tokens", "setup_id TEXT");
}

/** Installs environment-owned node binding columns at first cloud enrollment use. */
export function ensureWorkerEnvironmentNodeEnrollmentSchema(database: DatabaseSync): void {
  ensureDevicePairSetupCompletionSchema(database);
  ensureColumn(database, "worker_environments", "node_setup_id TEXT");
  ensureColumn(database, "worker_environments", "node_device_id TEXT");
}

/** Register fixed build ownership on the dedicated node's current transaction. */
export function ensureNodeWorkerPreparedWorkspaceSchema(database: DatabaseSync): void {
  // Registration can still roll back; never cache a nested transaction's DDL.
  database.exec(
    extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "node_worker_prepared_workspaces", {
      errorMessage: "Node prepared workspace schema marker is missing.",
    }),
  ); // sqlite-allow-raw -- Canonical first-use DDL; workspace rows use Kysely.
}

function resolveLegacyManagedImageRoot(recordJson: unknown): string | null {
  if (typeof recordJson !== "string") {
    return null;
  }
  let record: unknown;
  try {
    record = JSON.parse(recordJson) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(record) || !isRecord(record.original)) {
    return null;
  }
  const mediaRoot = record.original.mediaRoot;
  if (typeof mediaRoot === "string" && mediaRoot.trim()) {
    return path.resolve(mediaRoot);
  }
  const originalPath = record.original.path;
  if (typeof originalPath !== "string" || !originalPath.trim()) {
    return null;
  }
  const resolvedOriginalPath = path.resolve(originalPath);
  return path.dirname(path.dirname(path.dirname(resolvedOriginalPath)));
}

function backfillLegacyManagedImageRoots(db: DatabaseSync): void {
  const rows = db
    .prepare("SELECT attachment_id, record_json FROM managed_outgoing_image_records")
    .all() as Array<{ attachment_id: string; record_json: unknown }>;
  const updateRoot = db.prepare(
    "UPDATE managed_outgoing_image_records SET original_media_root = ? WHERE attachment_id = ?",
  );
  const deleteRecord = db.prepare(
    "DELETE FROM managed_outgoing_image_records WHERE attachment_id = ?",
  );
  for (const row of rows) {
    const mediaRoot = resolveLegacyManagedImageRoot(row.record_json);
    if (mediaRoot) {
      updateRoot.run(mediaRoot, row.attachment_id);
    } else {
      // This table had no shipped writer. Discard malformed unexpected rows
      // instead of retaining unusable empty roots or wedging every database open.
      deleteRecord.run(row.attachment_id);
    }
  }
}

function ensureWorkerSessionToolStateSchema(db: DatabaseSync): void {
  db.exec(
    [
      extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "worker_turn_tool_authorities"),
      extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "worker_session_tool_operations"),
    ].join("\n"),
  );
}

export function ensureGitHubPublicationSchema(db: DatabaseSync): void {
  db.exec(
    extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "github_publication_requests", {
      endMarker: "ON github_publication_requests(status, updated_at_ms, request_id);",
    }),
  );
}

/** First personal publication write only; status and old readers leave this surface dormant. */
export function ensurePersonalGitHubPublicationSchema(db: DatabaseSync): void {
  db.exec(
    extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "github_personal_publication_requests", {
      endMarker: "ON github_personal_publication_requests(status, updated_at_ms, request_id);",
      errorMessage: "Personal GitHub publication schema marker is missing.",
    }),
  ); // sqlite-allow-raw -- Canonical lazy additive DDL only.
}

/**
 * Add the feature-owned first-use columns that a STRICT rebuild cannot skip.
 *
 * These columns normally stay absent until their owning feature first writes
 * them, and the persistent schema contract accepts that shape. The STRICT
 * table rebuild is the one caller that cannot: it recreates each table from
 * canonical SQL, which already declares these columns, so a database missing
 * them fails the canonical column check and rolls the entire repair back.
 * Ensuring them immediately before that rebuild matches the shape the rebuild
 * produces anyway, and stays scoped to databases old enough to need it.
 */
export function ensureFirstUseAdditiveStateColumnsForStrictMigration(db: DatabaseSync): void {
  for (const {
    columnName,
    dataType,
    tableName,
  } of CLAW_FIRST_USE_ADDITIVE_STATE_COLUMN_DEFINITIONS) {
    ensureColumn(db, tableName, `${columnName} ${dataType}`);
  }
}

function ensureColumns(
  db: DatabaseSync,
  definitions: readonly (readonly [string, string])[],
): void {
  for (const definition of definitions) {
    ensureColumn(db, ...definition);
  }
}

export function ensureAdditiveStateColumns(db: DatabaseSync): void {
  ensureWorkerSessionToolStateSchema(db);
  for (const {
    columnName,
    dataType,
    tableName,
  } of CLAW_STARTUP_ADDITIVE_STATE_COLUMN_DEFINITIONS) {
    ensureColumn(db, tableName, `${columnName} ${dataType}`);
  }
  if (ensureColumn(db, ...columns.packageUpdatedAt[0])) {
    db.exec("UPDATE claw_package_refs SET updated_at_ms = installed_at_ms;");
  }
  ensureColumns(db, columns.packageIntegrity);
  const addedDiagnosticEventSequence = ensureColumn(db, ...columns.diagnosticSequence[0]);
  if (addedDiagnosticEventSequence) {
    // Preserve the legacy (created_at, rowid) order before the new sequence
    // index becomes authoritative, including stable ties within each scope.
    db.exec(`
      WITH ranked AS (
        SELECT
          rowid AS event_rowid,
          ROW_NUMBER() OVER (
            PARTITION BY scope
            ORDER BY created_at ASC, rowid ASC
          ) AS sequence
        FROM diagnostic_events
      )
      UPDATE diagnostic_events
      SET sequence = (
        SELECT ranked.sequence
        FROM ranked
        WHERE ranked.event_rowid = diagnostic_events.rowid
      );
    `);
  }
  db.exec("DROP INDEX IF EXISTS idx_diagnostic_events_scope_created;");
  ensureColumns(db, columns.cronRunLogs);
  backfillCronRunLogEntryJson(db);
  ensureColumns(db, columns.acpReplay);
  backfillAcpReplayEstimatedBytes(db);
  ensureColumns(db, columns.cronJobs);
  backfillCronJobsFromJobJson(db);
  ensureColumns(db, columns.deliveryQueue);
  backfillDeliveryQueueEntriesFromEntryJson(db);
  // The shipped JSON runtime predeclared this table but never populated it.
  // The transitional default makes ADD COLUMN portable; schema-v2 tables are
  // rebuilt from canonical STRICT SQL immediately afterward, removing it.
  const addedOriginalMediaRoot = ensureColumn(db, ...columns.originalMediaRoot[0]);
  if (addedOriginalMediaRoot) {
    backfillLegacyManagedImageRoots(db);
  }
  ensureColumns(db, columns.beforeTaskAttribution);
  const addedTaskRequesterAgentId = ensureColumn(db, ...columns.taskRequester[0]);
  if (addedTaskRequesterAgentId) {
    repairLegacyTaskAgentAttribution(db);
  }
  repairLegacyTaskDeliveryStatuses(db);
  ensureColumns(db, columns.taskRunDetails);
  repairLegacySubagentSuspensionReasons(db);
  repairLegacySubagentExecutionPayloads(db);
  repairLegacySubagentTaskBindings(db);
  repairLegacySubagentRetainedResults(db);
  ensureColumns(db, columns.workerEnvironments);
  ensureOperatorApprovalResolutionRefs(db);
}
