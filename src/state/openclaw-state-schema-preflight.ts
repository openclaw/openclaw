import type { DatabaseSync } from "node:sqlite";
import { formatErrorMessage } from "../infra/errors.js";
import { readSqliteDatabaseCleanClose } from "../infra/sqlite-database-admission.js";
import { assertSqliteIntegrity } from "../infra/sqlite-integrity.js";
import {
  captureSqliteSchemaContracts,
  type PreparedSqliteSchemaContract,
} from "../infra/sqlite-schema-contract.js";
import { readSqliteWriterAppVersion } from "../infra/sqlite-schema-header.js";
import { SqliteSchemaMismatchError } from "../infra/sqlite-schema-issues.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import { readRetainedAgentDeletionsFromDatabase } from "./agent-deletion-journal.read.js";
import type {
  AgentDeletionJournalDisposition,
  AgentDeletionJournalPurpose,
} from "./agent-deletion-journal.types.js";
import { readAgentDatabasePreflightTargets } from "./openclaw-agent-db-registry.read.js";
import { describeDeferredStateSchemaPublication } from "./openclaw-database-preflight.messages.js";
import type { OpenClawDatabaseSchemaPreflight } from "./openclaw-database-preflight.types.js";
import { getStateRuntimeSchemaAdmission } from "./openclaw-state-db-admission.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  assertOpenClawStateDatabaseForMaintenance,
  openClawStateMigrationAssertions,
} from "./openclaw-state-db-maintenance.js";
import { normalizeOpenClawStateSchemaReadError } from "./openclaw-state-db-schema-migration-required.js";
import { assertCanonicalStateSchemaShape } from "./openclaw-state-db-schema-repair.js";
import { readStateSchemaContentVersion } from "./openclaw-state-db-schema-version.js";
import { inspectOpenClawStateOwnershipFromDatabase } from "./openclaw-state-ownership.js";
import { inspectCurrentStateStartupSchema } from "./openclaw-state-schema-inspection.js";
import { readStateSchemaPublicationBlocker } from "./openclaw-state-schema-publication.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

export type StateSchemaInspectionInput = {
  pathname: string;
  supportedVersion: number;
  requireStartupMigrationReadiness?: boolean;
  verifyCurrentSchemaShape?: boolean;
  scope?: "state";
  purpose: AgentDeletionJournalPurpose;
  schemaContracts?: PreparedSqliteSchemaContract[];
};

export type StateSchemaInspection = {
  schemas: OpenClawDatabaseSchemaPreflight;
  schemaContracts?: PreparedSqliteSchemaContract[];
  registeredDatabases?: { agentId: string; path: string }[];
  deletionJournal?: AgentDeletionJournalDisposition;
  inspectionErrors: unknown[];
};

const canonicalStateInspectionSchemas = [OPENCLAW_STATE_SCHEMA_SQL];

/** Only trusted canonical definitions enter the expected-contract cache, never observed schemas. */
export function captureStateSchemaInspectionContracts(): PreparedSqliteSchemaContract[] {
  return captureSqliteSchemaContracts(canonicalStateInspectionSchemas);
}

/** Boot/Doctor and restart readers inspect the same captured bytes under their existing owner. */
export function inspectStateDatabaseSchema(
  database: DatabaseSync,
  input: StateSchemaInspectionInput,
): StateSchemaInspection {
  const { pathname, supportedVersion } = input;
  const schemas: OpenClawDatabaseSchemaPreflight = { incompatible: [], indeterminate: [] };
  const inspection: StateSchemaInspection = { schemas, inspectionErrors: [] };
  const cleanClose =
    input.purpose === "runtime" &&
    readSqliteDatabaseCleanClose(pathname) &&
    getStateRuntimeSchemaAdmission(database)?.startupReady === true;
  try {
    const stateVersion = readSqliteUserVersion(database);
    const contentVersion =
      stateVersion > supportedVersion
        ? stateVersion
        : readStateSchemaContentVersion(database, stateVersion);
    if (contentVersion > supportedVersion) {
      const writerAppVersion = readSqliteWriterAppVersion(database);
      schemas.incompatible.push({
        kind: "state",
        path: pathname,
        foundVersion: contentVersion,
        supportedVersion,
        ...(writerAppVersion ? { writerAppVersion } : {}),
      });
      // An older target does not make this build's readable registry unavailable.
      if (contentVersion > OPENCLAW_STATE_SCHEMA_VERSION) {
        return inspection;
      }
    }
    // An older target may have taken the header-only path; this build still needs the content marker.
    const migrationVersion =
      stateVersion > supportedVersion
        ? readStateSchemaContentVersion(database, stateVersion)
        : contentVersion;
    if (migrationVersion < supportedVersion) {
      schemas.pendingMigrations = [
        { kind: "state", path: pathname, foundVersion: stateVersion, supportedVersion },
      ];
    }
    if (stateVersion < contentVersion && migrationVersion === contentVersion) {
      schemas.deferredSchemaPublications = [
        describeDeferredStateSchemaPublication(
          readStateSchemaPublicationBlocker(database),
          pathname,
          stateVersion,
          contentVersion,
        ),
      ];
    }
    if (
      !cleanClose &&
      input.requireStartupMigrationReadiness &&
      contentVersion <= OPENCLAW_STATE_SCHEMA_VERSION
    ) {
      assertSqliteIntegrity(database, pathname);
      assertCanonicalStateSchemaShape(database, pathname);
      // Readiness must reject malformed ownership even when startup has no pending writes.
      inspectOpenClawStateOwnershipFromDatabase(database, pathname);
      if (migrationVersion === OPENCLAW_STATE_SCHEMA_VERSION) {
        const { blockingIssues } = inspectCurrentStateStartupSchema(
          database,
          pathname,
          stateVersion,
        );
        if (blockingIssues.length > 0) {
          throw new SqliteSchemaMismatchError(
            `OpenClaw state database ${pathname} requires repair: ${blockingIssues.map((issue) => issue.message).join("; ")}; run openclaw doctor --fix.`,
          );
        }
      } else {
        openClawStateMigrationAssertions.get(migrationVersion)?.(database, { pathname });
      }
    } else if (
      !cleanClose &&
      input.verifyCurrentSchemaShape &&
      migrationVersion === OPENCLAW_STATE_SCHEMA_VERSION
    ) {
      try {
        assertOpenClawStateDatabaseForMaintenance(database, {
          pathname,
          schemaVersions: { userVersion: stateVersion, contentVersion: migrationVersion },
        });
      } catch (error) {
        inspection.inspectionErrors.push(error);
        schemas.indeterminate.push({
          kind: "state",
          path: pathname,
          reason: formatErrorMessage(error),
        });
      }
    }
    if (input.scope === "state") {
      return inspection;
    }
    try {
      inspection.registeredDatabases = readAgentDatabasePreflightTargets(database, pathname);
      inspection.deletionJournal = readRetainedAgentDeletionsFromDatabase(
        database,
        pathname,
        input.purpose,
      );
    } catch (error) {
      inspection.inspectionErrors.push(error);
      schemas.indeterminate.push({
        kind: "state",
        path: pathname,
        reason: `agent database registry query failed: ${formatErrorMessage(error)}`,
      });
    }
    return inspection;
  } catch (error) {
    if (input.requireStartupMigrationReadiness) {
      throw error;
    }
    const failure = normalizeOpenClawStateSchemaReadError(error, pathname);
    inspection.inspectionErrors.push(failure);
    schemas.indeterminate.push({
      kind: "state",
      path: pathname,
      reason: formatErrorMessage(failure),
    });
    return inspection;
  }
}
