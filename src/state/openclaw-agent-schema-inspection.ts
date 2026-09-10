import type { DatabaseSync } from "node:sqlite";
import { formatErrorMessage } from "../infra/errors.js";
import { clearNodeSqliteKyselyCacheForDatabase } from "../infra/kysely-sync.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { assertOpenClawAgentDatabaseForMaintenance } from "./openclaw-agent-db-maintenance.js";
import {
  assertCanonicalAgentPersistenceVersion,
  readExistingAgentSchemaMeta,
} from "./openclaw-agent-db-schema-helpers.js";

export type AgentSchemaInspectionInput = {
  pathname: string;
  agentId?: string;
  supportedVersion: number;
  verifyCurrentSchemaShape?: boolean;
  requireStartupMigrationReadiness?: boolean;
};

export type AgentSchemaInspection = {
  version: number;
  writerAppVersion?: string;
  reason?: string;
};

/** All facts belong to the caller's single read transaction or private snapshot. */
export function inspectAgentDatabaseSchema(
  database: DatabaseSync,
  input: AgentSchemaInspectionInput,
): AgentSchemaInspection {
  const version = readSqliteUserVersion(database);
  try {
    if (version > input.supportedVersion) {
      try {
        const row = database
          .prepare("SELECT app_version FROM schema_meta WHERE meta_key = 'primary' LIMIT 1")
          .get();
        return {
          version,
          ...(typeof row?.app_version === "string" && row.app_version.length > 0
            ? { writerAppVersion: row.app_version }
            : {}),
        };
      } catch {
        // A newer schema may no longer expose the current metadata shape.
        return { version };
      }
    }
    if (input.requireStartupMigrationReadiness) {
      assertSqliteIntegrity(database, input.pathname);
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
      assertOpenClawAgentDatabaseForMaintenance(database, {
        agentId,
        pathname: input.pathname,
      });
    }
    return { version };
  } catch (error) {
    if (input.requireStartupMigrationReadiness) {
      throw error;
    }
    // Preserve the observed version even when shape validation fails, so Doctor
    // can still report a pending migration alongside the unreadable shape.
    return { version, reason: formatErrorMessage(error) };
  } finally {
    clearNodeSqliteKyselyCacheForDatabase(database);
  }
}
