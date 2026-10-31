import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { formatErrorMessage } from "../infra/errors.js";
import { clearNodeSqliteKyselyCacheForDatabase } from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase, resolveImmutableSqliteFileUri } from "../infra/node-sqlite.js";
import { setSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { readSqliteSchemaHeader } from "../infra/sqlite-schema-header.js";
import { readMainTableList } from "../infra/sqlite-strict.js";
import { readSqliteUserVersion, readSqliteWriterAppVersion } from "../infra/sqlite-user-version.js";
import { configureSqliteReadOnlyPragmas } from "../infra/sqlite-wal.js";
import { isValidAgentId } from "../routing/session-key.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { assertOpenClawAgentDatabaseForMaintenance } from "./openclaw-agent-db-maintenance.js";
import type { ExistingAgentSchemaMeta } from "./openclaw-agent-db-metadata.js";
import {
  assertCanonicalAgentPersistenceVersion,
  assertOpenClawAgentCurrentRuntimeSchema,
  readExistingAgentSchemaMeta,
  hasPendingCurrentVersionAgentDatabaseMigration,
  assertOpenClawAgentSchemaContains,
  getOpenClawAgentMigrationSchema,
} from "./openclaw-agent-db-schema-helpers.js";
import type { OpenClawAgentSchemaPreflightResult } from "./openclaw-database-preflight.types.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "./openclaw-state-db-contract.js";
import { resolveSchemaMigrationIntegrityCheck } from "./schema-migration-backup-scope.js";

export type AgentSchemaInspectionInput = {
  pathname: string;
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  supportedVersion: number;
  verifyCurrentSchemaShape?: boolean;
  inspectOwnership?: boolean;
  requireStartupMigrationReadiness?: boolean;
  deferRuntimeIntegrity?: boolean;
  startupIntegrityVerification?: { verifiedAt: number };
  inspectEmptyStore?: boolean;
};

export type AgentSchemaInspection = {
  version: number;
  /** Exact current shape without repair; not an integrity verdict or writable admission. */
  readReady?: true;
  integrityGateOutcome?: "cached" | "healthy";
  preparationPending?: true;
  writerAppVersion?: string;
  reason?: string;
  failure?: Error;
  agentSchemaMeta?: ExistingAgentSchemaMeta | null;
  emptyStore?: boolean;
};

/** Only schema/default index metadata may survive a turn-less first run. */
function isEmptyAgentStore(
  database: DatabaseSync,
  input: AgentSchemaInspectionInput,
  version: number,
  metadata: ExistingAgentSchemaMeta | null | undefined,
): boolean {
  if (
    !input.agentId ||
    metadata?.role !== "agent" ||
    metadata.agentId !== input.agentId ||
    metadata.schemaVersion == null ||
    metadata.schemaVersion !== version ||
    metadata.schemaVersion < 24 ||
    metadata.schemaVersion > OPENCLAW_AGENT_SCHEMA_VERSION
  ) {
    return false;
  }
  assertSqliteIntegrity(database, input.pathname);
  assertOpenClawAgentSchemaContains(
    database,
    input.pathname,
    getOpenClawAgentMigrationSchema(metadata.schemaVersion),
  );
  for (const table of readMainTableList(database, { includeInternal: true })) {
    if (table.type === "shadow" || table.name === "sqlite_schema") {
      continue;
    }
    const name = table.name;
    if (name.startsWith("sqlite_stat")) {
      continue;
    }
    const allowed =
      name === "schema_meta"
        ? "meta_key = 'primary'"
        : name === "session_key_contract"
          ? "id = 1 AND updated_at = 0"
          : name === "memory_index_meta"
            ? "key = 'memory_index_meta_v1' OR (key = 'memory_vector_rebuild_v1' AND value = 'clean')"
            : name === "memory_index_state"
              ? "id = 1 AND revision = 0"
              : name === "sqlite_sequence"
                ? "seq = 0"
                : "0";
    if (
      // sqlite-allow-raw -- Catalog-owned identifiers; a bounded existence probe never loads content.
      database
        .prepare(
          `SELECT 1 FROM "${name.replaceAll('"', '""')}" WHERE (${allowed}) IS NOT TRUE LIMIT 1`,
        )
        .get()
    ) {
      return false;
    }
  }
  return true;
}

/** All facts belong to the caller's single read transaction or private snapshot. */
export function inspectAgentDatabaseSchema(
  database: DatabaseSync,
  input: AgentSchemaInspectionInput,
): AgentSchemaInspection {
  if (!input.verifyCurrentSchemaShape && !input.requireStartupMigrationReadiness) {
    try {
      const { userVersion, ...header } = readSqliteSchemaHeader(
        database,
        input.inspectOwnership ? input.supportedVersion : undefined,
      );
      return {
        version: userVersion,
        ...header,
        ...(input.inspectEmptyStore
          ? {
              emptyStore:
                userVersion <= input.supportedVersion &&
                isEmptyAgentStore(database, input, userVersion, header.agentSchemaMeta),
            }
          : {}),
      };
    } finally {
      clearNodeSqliteKyselyCacheForDatabase(database);
    }
  }
  const version = readSqliteUserVersion(database);
  const inspection: AgentSchemaInspection = { version };
  let checkingShape = false;
  let migrationPending = true;
  try {
    if (version > input.supportedVersion) {
      const writerAppVersion = readSqliteWriterAppVersion(database);
      return { version, ...(writerAppVersion ? { writerAppVersion } : {}) };
    }
    if (input.inspectOwnership) {
      // Preserve ownership even when shape validation fails: the parent must
      // apply its existing isolation decision before reporting schema defects.
      inspection.agentSchemaMeta = readExistingAgentSchemaMeta(database);
    }
    if (input.requireStartupMigrationReadiness) {
      migrationPending =
        version !== input.supportedVersion ||
        hasPendingCurrentVersionAgentDatabaseMigration(database);
      if (input.startupIntegrityVerification !== undefined && !migrationPending) {
        inspection.integrityGateOutcome = "cached";
      } else if (input.deferRuntimeIntegrity && !migrationPending) {
        // The pending Gateway owner claims the live lease and validates before writes.
        inspection.preparationPending = true;
      } else {
        assertSqliteIntegrity(
          database,
          input.pathname,
          version < input.supportedVersion
            ? resolveSchemaMigrationIntegrityCheck({
                kind: "agent",
                foundVersion: version,
                supportedVersion: input.supportedVersion,
              })
            : undefined,
        );
        inspection.integrityGateOutcome = "healthy";
      }
      if (migrationPending && version === input.supportedVersion) {
        inspection.preparationPending = true;
      }
      assertCanonicalAgentPersistenceVersion(database, input.pathname, version);
    }
    const agentId =
      input.agentId ??
      (input.requireStartupMigrationReadiness
        ? readExistingAgentSchemaMeta(database)?.agentId
        : undefined);
    if (
      input.verifyCurrentSchemaShape &&
      agentId != null &&
      (!input.requireStartupMigrationReadiness || version > 0)
    ) {
      checkingShape = true;
      const needsIndexRepair = assertOpenClawAgentDatabaseForMaintenance(database, {
        agentId,
        pathname: input.pathname,
        allowStartupIndexRepair: input.requireStartupMigrationReadiness,
      });
      if (needsIndexRepair) {
        inspection.preparationPending = true;
      } else if (!migrationPending && version === input.supportedVersion) {
        inspection.readReady = true;
      }
    }
    return inspection;
  } catch (error) {
    if (input.requireStartupMigrationReadiness) {
      return {
        ...inspection,
        failure: toStringifiedError(error),
        ...(checkingShape ? { reason: formatErrorMessage(error) } : {}),
      };
    }
    // Preserve the observed version even when shape validation fails, so Doctor
    // can still report a pending migration alongside the unreadable shape.
    return { ...inspection, reason: formatErrorMessage(error) };
  } finally {
    clearNodeSqliteKyselyCacheForDatabase(database);
  }
}

/** Validate one consolidated agent copy using this release's exact maintenance reader.
 * This never discovers, registers, migrates, or opens an ordinary runtime store.
 */
export async function preflightOpenClawAgentDatabasePath(
  databasePath: string,
  agentId: string,
): Promise<OpenClawAgentSchemaPreflightResult> {
  const resolvedPath = path.resolve(databasePath);
  const base = {
    schema: "openclaw.agent-schema-preflight.v1" as const,
    databasePath: resolvedPath,
    agentId,
    targetVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
    requiresWrite: false,
    issues: [],
  };
  let database: DatabaseSync | undefined;
  let foundVersion: number | null = null;
  let status: "indeterminate" | "incompatible" = "indeterminate";
  try {
    // The maintenance owner normalizes IDs. An explicit proof must never fall
    // back to main or silently bless a different, normalized input identity.
    if (!isValidAgentId(agentId) || agentId !== agentId.trim().toLowerCase()) {
      throw new Error("Agent preflight requires an explicit canonical agent ID.");
    }
    const inspectionPath = realpathSync.native(resolvedPath);
    if (inspectionPath !== resolvedPath || !statSync(inspectionPath).isFile()) {
      throw new Error("Agent preflight requires a canonical regular copied database path.");
    }
    if (["-wal", "-shm", "-journal"].some((suffix) => existsSync(inspectionPath + suffix))) {
      throw new Error("Agent preflight requires a consolidated snapshot with no SQLite sidecars.");
    }
    database = openNodeSqliteDatabase(resolveImmutableSqliteFileUri(inspectionPath), {
      readOnly: true,
    });
    setSqliteBusyTimeout(database, OPENCLAW_SQLITE_BUSY_TIMEOUT_MS);
    configureSqliteReadOnlyPragmas(database);
    assertSqliteIntegrity(database, resolvedPath);
    foundVersion = readSqliteUserVersion(database);
    status = "incompatible";
    assertOpenClawAgentDatabaseForMaintenance(database, { agentId, pathname: resolvedPath });
    // Maintenance-compatible storage can still require a retired-schema repair
    // before runtime admission. A read-only proof must never bless that repair.
    assertOpenClawAgentCurrentRuntimeSchema(database, { agentId, pathname: resolvedPath });
    return { ...base, foundVersion, status: "exact" as const };
  } catch (error) {
    return { ...base, foundVersion, status, reason: formatErrorMessage(error) };
  } finally {
    if (database) {
      clearNodeSqliteKyselyCacheForDatabase(database);
    }
    database?.close();
  }
}
