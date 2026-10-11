import type { DatabaseSync } from "node:sqlite";
import {
  clearNodeSqliteKyselyCacheForDatabase,
  enableNodeSqliteKyselyStatementCache,
} from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { repairDoctorSqliteIndexCorruption } from "../infra/sqlite-index-recovery.js";
import { runSqliteIntegrityOperationInWorker } from "../infra/sqlite-integrity-operation.js";
import { configureSqliteMaintenanceCache } from "../infra/sqlite-maintenance-cache.js";
import { invalidateSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import { SqliteSchemaMismatchError } from "../infra/sqlite-schema-issues.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  AGENT_MEDIA_SCHEMA_VERSION,
  OPENCLAW_AGENT_SCHEMA_VERSION,
} from "./openclaw-agent-db-contract.js";
import {
  assertAgentDatabaseMaintenanceAuthority,
  invalidateOpenClawAgentDatabaseIntegrityBeforeMutation,
} from "./openclaw-agent-db-lease.js";
import {
  assertExistingAgentSchemaOwner,
  assertOpenClawAgentSchemaContains,
  assertSupportedAgentSchemaVersion,
  readExistingAgentSchemaMeta,
} from "./openclaw-agent-db-schema-helpers.js";
import { ensureOpenClawAgentDatabaseSchemaSteps } from "./openclaw-agent-db-schema.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "./openclaw-state-db.js";
import type { OpenClawStateLeaseContext } from "./openclaw-state-lease.js";

const agentDbLog = createSubsystemLogger("state/agent-db");

/** Require exact agent ownership without requiring the latest schema. */
export function assertOpenClawAgentDatabaseOwner(
  database: DatabaseSync,
  options: { agentId: string; pathname: string },
): NonNullable<ReturnType<typeof readExistingAgentSchemaMeta>> {
  // Explicit maintenance inspects the current file, including external damage after admission.
  invalidateSqliteSchemaFacts(database);
  const agentId = normalizeAgentId(options.agentId);
  const metadata = readExistingAgentSchemaMeta(database);
  if (!metadata) {
    throw new SqliteSchemaMismatchError(
      `OpenClaw agent database ${options.pathname} has no schema ownership metadata. Run openclaw doctor --fix to inspect and repair its ownership.`,
    );
  }
  assertExistingAgentSchemaOwner(metadata, agentId, options.pathname);
  if (metadata.agentId !== agentId) {
    throw new SqliteSchemaMismatchError(
      `OpenClaw agent database ${options.pathname} belongs to agent ${metadata.agentId}; requested agent ${agentId}.`,
    );
  }
  return metadata;
}

/** Require the exact agent owner and schema before offline file maintenance. */
export function assertOpenClawAgentDatabaseForMaintenance(
  database: DatabaseSync,
  options: { agentId: string; pathname: string; allowStartupIndexRepair?: boolean },
): boolean {
  const metadata = assertOpenClawAgentDatabaseOwner(database, options);

  const userVersion = assertSupportedAgentSchemaVersion(database, options.pathname);
  if (userVersion !== OPENCLAW_AGENT_SCHEMA_VERSION) {
    throw new SqliteSchemaMismatchError(
      `OpenClaw agent database ${options.pathname} uses schema version ${userVersion}; run openclaw doctor --fix before compacting it.`,
    );
  }
  if (metadata.schemaVersion !== OPENCLAW_AGENT_SCHEMA_VERSION) {
    throw new SqliteSchemaMismatchError(
      `OpenClaw agent database ${options.pathname} metadata schema version ${metadata.schemaVersion ?? "invalid"} does not match ${OPENCLAW_AGENT_SCHEMA_VERSION}; run openclaw doctor --fix before compacting it.`,
    );
  }
  return assertOpenClawAgentSchemaContains(
    database,
    options.pathname,
    OPENCLAW_AGENT_SCHEMA_SQL,
    "current",
    options.allowStartupIndexRepair,
  );
}

/** Upgrade or repair a supported owned schema before strict offline maintenance. */
export async function migrateOpenClawAgentDatabaseForMaintenance(
  options: { agentId: string; pathname: string },
  maintenance: OpenClawStateLeaseContext,
): Promise<void> {
  const agentId = normalizeAgentId(options.agentId);
  const pathname = options.pathname;
  const env = { ...process.env };
  const assertOwned = () => {
    maintenance.signal.throwIfAborted();
    assertAgentDatabaseMaintenanceAuthority(maintenance);
  };
  assertOwned();
  invalidateOpenClawAgentDatabaseIntegrityBeforeMutation(pathname, env);
  const database = openNodeSqliteDatabase(pathname);
  try {
    invalidateSqliteSchemaFacts(database);
    configureSqliteMaintenanceCache(database);
    enableNodeSqliteKyselyStatementCache(database);
    database.exec(`PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS};`);
    const metadata = readExistingAgentSchemaMeta(database);
    if (!metadata) {
      return;
    }
    assertExistingAgentSchemaOwner(metadata, agentId, pathname);
    assertSupportedAgentSchemaVersion(database, pathname);
    const userVersion = readSqliteUserVersion(database);
    const metadataVersion = metadata.schemaVersion;
    const hasCurrentVersion =
      userVersion === OPENCLAW_AGENT_SCHEMA_VERSION &&
      metadataVersion === OPENCLAW_AGENT_SCHEMA_VERSION;
    const hasSupportedOlderVersion =
      userVersion >= 1 &&
      userVersion < OPENCLAW_AGENT_SCHEMA_VERSION &&
      metadataVersion === userVersion;
    if (!hasCurrentVersion && !hasSupportedOlderVersion) {
      return;
    }
    const repairIndexes = () => {
      const changes = repairDoctorSqliteIndexCorruption(database, pathname, {
        label: `agent ${agentId}`,
        assertCurrent: () => {
          assertOwned();
          assertOpenClawAgentDatabaseOwner(database, { agentId, pathname });
          assertSupportedAgentSchemaVersion(database, pathname);
        },
      });
      for (const change of changes) {
        agentDbLog.warn(change);
      }
      return changes.length > 0;
    };
    if (userVersion === AGENT_MEDIA_SCHEMA_VERSION) {
      // v17 checks integrity inside its additive-schema transaction; repair only
      // physical indexes here so rejected migrations still roll schema changes back.
      repairIndexes();
    }
    const operation = ensureOpenClawAgentDatabaseSchemaSteps(database, {
      agentId,
      path: pathname,
      env,
    });
    await runSqliteIntegrityOperationInWorker(operation, {
      busyTimeoutMs: OPENCLAW_SQLITE_BUSY_TIMEOUT_MS,
      signal: maintenance.signal,
      beforeResume: () => {
        assertOwned();
        invalidateSqliteSchemaFacts(database);
        assertExistingAgentSchemaOwner(readExistingAgentSchemaMeta(database), agentId, pathname);
        assertSupportedAgentSchemaVersion(database, pathname);
      },
      repairIntegrityError: repairIndexes,
    });
    assertOwned();
    assertOpenClawAgentDatabaseForMaintenance(database, {
      agentId,
      pathname,
    });
  } finally {
    clearNodeSqliteKyselyCacheForDatabase(database);
    database.close();
  }
}
