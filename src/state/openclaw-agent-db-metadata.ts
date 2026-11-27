import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import { getPostgresPhysicalFacts } from "../infra/database-engine/physical-facts.js";
import { isPostgresSqlConnection, type EngineConnection } from "../infra/sql-connection.js";
import {
  getSqliteDatabaseAdmission,
  publishSqliteDatabaseAdmission,
  type SqliteDatabaseAdmissionKey,
} from "../infra/sqlite-database-admission.js";
import { schemaAdmission } from "../infra/sqlite-schema-admission.js";
import { getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import { SqliteSchemaMismatchError } from "../infra/sqlite-schema-issues.js";
import { classifySqliteTableReadError, tableExists } from "./openclaw-state-db-schema-helpers.js";

export type ExistingAgentSchemaMeta = {
  agentId: string | null;
  role: string | null;
  schemaVersion: number | null;
  /** Absent for the implicit floor derived from the writer's version markers. */
  minReader?: number;
};

export const agentSchemaMetadataKey: SqliteDatabaseAdmissionKey<ExistingAgentSchemaMeta> = {
  // Fixed ownership is reusable until tracked DDL can remove or rebuild its storage.
  name: "agent.schema-metadata",
  lifetime: "process",
  schemaDependent: true,
  read(value) {
    if (
      typeof value !== "object" ||
      value === null ||
      !("agentId" in value) ||
      (value.agentId !== null && typeof value.agentId !== "string") ||
      !("role" in value) ||
      (value.role !== null && typeof value.role !== "string") ||
      !("schemaVersion" in value) ||
      (value.schemaVersion !== null && typeof value.schemaVersion !== "number") ||
      ("minReader" in value && value.minReader != null && typeof value.minReader !== "number")
    ) {
      return undefined;
    }
    return {
      agentId: value.agentId,
      role: value.role,
      schemaVersion: value.schemaVersion,
      ...("minReader" in value && typeof value.minReader === "number"
        ? { minReader: value.minReader }
        : {}),
    };
  },
};

function schemaMetadataKey(
  admissionId: string,
): SqliteDatabaseAdmissionKey<ExistingAgentSchemaMeta> {
  return { name: `agent.schema-metadata:${admissionId}`, read: agentSchemaMetadataKey.read };
}

/** The metadata writer publishes its committed format facts without a readback. */
export function publishAgentSchemaMetadata(
  db: EngineConnection,
  metadata: ExistingAgentSchemaMeta,
): void {
  publishSqliteDatabaseAdmission(db, agentSchemaMetadataKey, metadata);
  const schema = getAdmittedSqliteSchemaFacts(db);
  if (schema) {
    publishSqliteDatabaseAdmission(db, schemaMetadataKey(schema.admissionId), metadata);
  }
}

/** Read ownership metadata without loading runtime schema or migration owners. */
export function readExistingAgentSchemaMeta(db: EngineConnection): ExistingAgentSchemaMeta | null {
  const schema = getAdmittedSqliteSchemaFacts(db);
  const historical =
    schema && getSqliteDatabaseAdmission(db, schemaMetadataKey(schema.admissionId));
  if (historical) {
    return historical;
  }
  const admitted =
    !schema || getSqliteDatabaseAdmission(db, schemaAdmission)?.admissionId === schema.admissionId
      ? getSqliteDatabaseAdmission(db, agentSchemaMetadataKey)
      : undefined;
  if (admitted) {
    if (schema) {
      publishSqliteDatabaseAdmission(db, schemaMetadataKey(schema.admissionId), admitted);
    }
    return admitted;
  }
  if (!tableExists(db, "schema_meta")) {
    return null;
  }
  // Unknown DDL can recreate the same table without its row; catalog text cannot carry this proof.
  let row;
  try {
    row = db
      .prepare(
        "SELECT role, schema_version, agent_id, schema_meta.* FROM schema_meta WHERE meta_key = 'primary'",
      )
      .get();
  } catch (error) {
    throw classifySqliteTableReadError(
      db,
      "schema_meta",
      ["meta_key", "role", "schema_version", "agent_id"],
      error,
    );
  }
  if (!row) {
    return null;
  }
  const schemaVersion = typeof row.schema_version === "number" ? row.schema_version : null;
  const physical = isPostgresSqlConnection(db) ? getPostgresPhysicalFacts(db) : undefined;
  const minReader = isPostgresSqlConnection(db)
    ? physical && physical.minReader !== physical.version
      ? physical.minReader
      : undefined
    : row.min_reader;
  if (
    minReader != null &&
    (typeof minReader !== "number" ||
      !Number.isSafeInteger(minReader) ||
      minReader < (schemaVersion === 0 ? 0 : 1) ||
      schemaVersion === null ||
      minReader > schemaVersion)
  ) {
    throw new SqliteSchemaMismatchError(
      "OpenClaw agent database min_reader must be a safe integer between 1 and schema_version (or 0 for schema version 0). Run openclaw doctor --fix before using it.",
    );
  }
  const metadata = {
    agentId: normalizeNullableString(row.agent_id),
    role: typeof row.role === "string" ? row.role : null,
    schemaVersion,
    ...(minReader != null ? { minReader } : {}),
  };
  const schemaStillCurrent = schema && getAdmittedSqliteSchemaFacts(db) === schema;
  if (
    isPostgresSqlConnection(db) ||
    (schemaStillCurrent &&
      getSqliteDatabaseAdmission(db, schemaAdmission)?.admissionId === schema.admissionId)
  ) {
    publishAgentSchemaMetadata(db, metadata);
  } else if (schemaStillCurrent) {
    publishSqliteDatabaseAdmission(db, schemaMetadataKey(schema.admissionId), metadata);
  }
  return metadata;
}
