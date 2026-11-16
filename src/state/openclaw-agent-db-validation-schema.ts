import { getPostgresPhysicalFacts } from "../infra/database-engine/physical-facts.js";
import { isPostgresSqlConnection, type EngineConnection } from "../infra/sql-connection.js";
import {
  getSqliteDatabaseAdmission,
  publishSqliteDatabaseAdmission,
  readSqliteDatabaseIntegrityVerification,
  recordSqliteDatabaseIntegrity,
} from "../infra/sqlite-database-admission.js";
import {
  adoptSqliteSchemaFacts,
  getAdmittedSqliteSchemaFacts,
} from "../infra/sqlite-schema-facts.js";
import { adoptCanonicalSessionValidationSchema } from "./openclaw-agent-canonical-validation-schema.js";
import {
  agentDatabaseValidationKey,
  type OpenClawAgentDatabaseValidation,
} from "./openclaw-agent-db-validation-facts.js";

/** Consume only a live physical owner's schema proof at connection admission. */
export function adoptAgentValidationSchema(
  database: { db: EngineConnection },
  validation: OpenClawAgentDatabaseValidation | undefined,
  reuseIntegrity: boolean,
  required: boolean,
): boolean {
  const schema = validation?.schema;
  // The cache owner already matched physical identity; read admission supplies the same
  // schema markers as native adoption, even when a sibling retained its own catalog.
  const admitted =
    reuseIntegrity && schema && !database.db.isTransaction
      ? getAdmittedSqliteSchemaFacts(database.db)
      : undefined;
  const postgres =
    reuseIntegrity && schema?.postgres && !database.db.isTransaction
      ? getPostgresPhysicalFacts(database.db)
      : undefined;
  const adopted = Boolean(
    reuseIntegrity &&
    schema &&
    Atomics.load(new Int32Array(schema.valid), 0) === 1 &&
    (schema.postgres
      ? postgres?.storeId === schema.postgres.storeId &&
        postgres.namespace === schema.postgres.namespace &&
        postgres.version === schema.postgres.version
      : !isPostgresSqlConnection(database.db) &&
        ((admitted?.schemaVersion === schema.facts.schemaVersion &&
          admitted.userVersion === schema.facts.userVersion) ||
          adoptSqliteSchemaFacts(database.db, schema.facts))) &&
    Atomics.load(new Int32Array(schema.valid), 0) === 1,
  );
  if (required && !adopted) {
    throw new Error("Agent schema admission changed before handle adoption; retry the operation");
  }
  if (adopted) {
    adoptCanonicalSessionValidationSchema(database.db);
    if (validation?.integrityVerifiedAt !== undefined && !isPostgresSqlConnection(database.db)) {
      if (readSqliteDatabaseIntegrityVerification(database.db) === undefined) {
        recordSqliteDatabaseIntegrity(database.db, validation.integrityVerifiedAt);
      }
      if (
        getSqliteDatabaseAdmission(database.db, agentDatabaseValidationKey)?.receiptId !==
        validation.receiptId
      ) {
        publishSqliteDatabaseAdmission(database.db, agentDatabaseValidationKey, validation);
      }
    }
  }
  return adopted;
}

export function matchesValidationSchema(
  left: NonNullable<OpenClawAgentDatabaseValidation["schema"]>,
  right: NonNullable<OpenClawAgentDatabaseValidation["schema"]>,
): boolean {
  if (left.postgres || right.postgres) {
    return Boolean(
      left.postgres &&
      right.postgres &&
      left.postgres.storeId === right.postgres.storeId &&
      left.postgres.namespace === right.postgres.namespace &&
      left.postgres.version === right.postgres.version,
    );
  }
  return (
    left.facts.schemaVersion === right.facts.schemaVersion &&
    left.facts.userVersion === right.facts.userVersion
  );
}

/** The open/migration owner calls this only after complete canonical schema validation. */
export function publishAgentValidationSchema(
  database: { db: EngineConnection },
  validation: OpenClawAgentDatabaseValidation | undefined,
): void {
  const facts = getAdmittedSqliteSchemaFacts(database.db);
  const postgres = isPostgresSqlConnection(database.db)
    ? getPostgresPhysicalFacts(database.db)
    : undefined;
  if (validation && (facts || postgres) && !database.db.isTransaction) {
    // Repeated publication preserves borrowers; real DDL revokes their shared cell.
    let valid = validation.schema?.valid;
    if (!valid || Atomics.load(new Int32Array(valid), 0) !== 1) {
      valid = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
      Atomics.store(new Int32Array(valid), 0, 1);
    }
    if (postgres) {
      validation.schema = { postgres, valid };
    } else if (facts) {
      validation.schema = { facts, valid };
    }
    publishSqliteDatabaseAdmission(database.db, agentDatabaseValidationKey, validation);
  }
}
