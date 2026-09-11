import { existsSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { formatErrorMessage } from "../infra/errors.js";
import { clearNodeSqliteKyselyCacheForDatabase } from "../infra/kysely-sync.js";
import { openNodeSqliteDatabase, resolveImmutableSqliteFileUri } from "../infra/node-sqlite.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { isValidAgentId } from "../routing/session-key.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { assertOpenClawAgentDatabaseForMaintenance } from "./openclaw-agent-db-maintenance.js";
import { assertOpenClawAgentCurrentRuntimeSchema } from "./openclaw-agent-db-schema-helpers.js";
import type { OpenClawAgentSchemaPreflightResult } from "./openclaw-database-preflight.types.js";
import { OPENCLAW_SQLITE_BUSY_TIMEOUT_MS } from "./openclaw-state-db-contract.js";

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
    database.exec(
      `PRAGMA busy_timeout = ${OPENCLAW_SQLITE_BUSY_TIMEOUT_MS}; PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;`,
    );
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
