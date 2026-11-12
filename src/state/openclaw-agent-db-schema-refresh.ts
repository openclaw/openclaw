import { isPostgresSqlConnection } from "../infra/sql-connection.js";
import {
  readSqliteDatabaseIntegrityVerification,
  settleSqliteDatabaseAdmissionPublication,
} from "../infra/sqlite-database-admission.js";
import { runSqliteIntegrityOperationSync } from "../infra/sqlite-integrity.js";
import { runSqliteSchemaReadSnapshotSync } from "../infra/sqlite-pinned-read-snapshot.js";
import {
  admitSqliteSchema,
  adoptSqliteSchemaFacts,
  getAdmittedSqliteSchemaFacts,
  runSqliteReadOperationSync,
} from "../infra/sqlite-schema-facts.js";
import { AgentDatabaseSchemaAdmissionChangedError } from "./agent-database-admission-error.js";
import { assertCanonicalSessionValidationSchema } from "./openclaw-agent-canonical-validation-schema.js";
import type { OpenClawAgentDatabase } from "./openclaw-agent-db-contract.js";
import {
  assertSupportedAgentSchemaVersion,
  assertCurrentAgentSchemaMetadata,
  assertCanonicalAgentPersistenceVersion,
  readExistingAgentSchemaMeta,
} from "./openclaw-agent-db-schema-read.js";
import {
  agentDatabaseIntegrityBeforeMutationSteps,
  ensureOpenClawAgentSchema,
} from "./openclaw-agent-db-schema.js";
import {
  adoptOpenClawAgentDatabaseSchema,
  getOpenClawAgentDatabaseValidation,
  invalidateOpenClawAgentDatabaseSchema,
  invalidateOpenClawAgentDatabaseValidation,
  setOpenClawAgentDatabaseValidation,
} from "./openclaw-agent-db-validation-cache.js";

/** Re-admit the retained connection without replacing its native generation or lease. */
export function refreshOpenClawAgentDatabaseSchema(
  database: OpenClawAgentDatabase,
  assertCurrent: () => void,
  runtimeAdmission = true,
) {
  const { db, agentId, path: pathname } = database;
  assertCurrent();
  if (db.isTransaction) {
    throw new Error("Agent schema admission requires a settled writer");
  }
  if (isPostgresSqlConnection(db)) {
    const validation = getOpenClawAgentDatabaseValidation(database);
    if (!validation || !adoptOpenClawAgentDatabaseSchema(database)) {
      throw new Error("Agent PostgreSQL schema admission changed; reopen the database");
    }
    return validation;
  }
  try {
    const reused = runSqliteReadOperationSync(db, () => {
      assertSupportedAgentSchemaVersion(db, pathname);
      assertCurrentAgentSchemaMetadata(readExistingAgentSchemaMeta(db), agentId, pathname);
      const validation = getOpenClawAgentDatabaseValidation(database);
      return validation && adoptOpenClawAgentDatabaseSchema(database) ? validation : undefined;
    });
    const verification = readSqliteDatabaseIntegrityVerification(db);
    if (reused && (runtimeAdmission || verification)) {
      return reused;
    }
    const validation = getOpenClawAgentDatabaseValidation(database);
    invalidateOpenClawAgentDatabaseSchema(database);
    const convergence = runSqliteIntegrityOperationSync(
      agentDatabaseIntegrityBeforeMutationSteps(db, agentId, pathname, {
        runtimeAdmission,
        verification,
        reuseRuntimeIntegrity: Boolean(validation),
      }),
      assertCurrent,
    );
    assertCanonicalAgentPersistenceVersion(db, pathname);
    if (convergence) {
      ensureOpenClawAgentSchema(db, agentId, pathname);
    }
    // Integrity admission or same-version repair already checked the runtime schema.
    const checkedSchema = runSqliteSchemaReadSnapshotSync(db, () => {
      admitSqliteSchema(db);
      assertCanonicalSessionValidationSchema(db);
      assertCurrent();
      return getAdmittedSqliteSchemaFacts(db);
    });
    // Release the pin before host publication, retaining only the catalog we checked.
    if (!checkedSchema || !adoptSqliteSchemaFacts(db, checkedSchema)) {
      throw new AgentDatabaseSchemaAdmissionChangedError();
    }
    assertCurrent();
    const refreshed = setOpenClawAgentDatabaseValidation(database);
    if (!settleSqliteDatabaseAdmissionPublication(db)) {
      throw new Error("Agent schema publication requires a settled connection");
    }
    return refreshed;
  } catch (error) {
    invalidateOpenClawAgentDatabaseValidation(pathname);
    throw error;
  }
}
