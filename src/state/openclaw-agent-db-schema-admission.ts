import type { DatabaseSync } from "node:sqlite";
import { readSqliteDatabaseIntegrityVerification } from "../infra/sqlite-database-admission.js";
import {
  admitSqliteSchema,
  getAdmittedSqliteSchemaFacts,
  isSqliteSchemaAdmissionCold,
} from "../infra/sqlite-schema-facts.js";
import { assertCanonicalSessionValidationSchema } from "./openclaw-agent-canonical-validation-schema.js";
import { registerOpenClawAgentDatabaseIdentity } from "./openclaw-agent-db-identity.js";
import { setOpenClawAgentDatabaseValidation } from "./openclaw-agent-db-validation-cache.js";

/** Publish completed canonical schema admission from the still-open maintenance handle. */
export function admitOpenClawAgentDatabaseSchema(
  db: DatabaseSync,
  options: { agentId: string; path: string },
): DatabaseSync | undefined {
  // Quick migration coverage cannot satisfy the next runtime full-integrity gate.
  if (
    db.location() &&
    readSqliteDatabaseIntegrityVerification(db) &&
    (isSqliteSchemaAdmissionCold(db) || getAdmittedSqliteSchemaFacts(db))
  ) {
    admitSqliteSchema(db);
    assertCanonicalSessionValidationSchema(db);
    registerOpenClawAgentDatabaseIdentity(db);
    setOpenClawAgentDatabaseValidation({ db, ...options });
    return db;
  }
  return undefined;
}
