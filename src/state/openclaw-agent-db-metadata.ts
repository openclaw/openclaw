import type { DatabaseSync } from "node:sqlite";
import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import {
  getSqliteDatabaseAdmission,
  publishSqliteDatabaseAdmission,
  type SqliteDatabaseAdmissionKey,
} from "../infra/sqlite-database-admission.js";
import { schemaAdmission } from "../infra/sqlite-schema-admission.js";
import {
  getAdmittedSqliteSchemaFacts,
  getSqliteReadScopeRevision,
} from "../infra/sqlite-schema-facts.js";
import { classifySqliteTableReadError, tableExists } from "./openclaw-state-db-schema-helpers.js";

export type ExistingAgentSchemaMeta = {
  agentId: string | null;
  role: string | null;
  schemaVersion: number | null;
};

const metadataKey: SqliteDatabaseAdmissionKey<ExistingAgentSchemaMeta> = {
  // Fixed ownership is reusable until tracked DDL can remove or rebuild its storage.
  name: "agent.schema-metadata",
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
      (value.schemaVersion !== null && typeof value.schemaVersion !== "number")
    ) {
      return undefined;
    }
    return { agentId: value.agentId, role: value.role, schemaVersion: value.schemaVersion };
  },
};

function schemaMetadataKey(
  admissionId: string,
): SqliteDatabaseAdmissionKey<ExistingAgentSchemaMeta> {
  return { name: `agent.schema-metadata:${admissionId}`, read: metadataKey.read };
}

/** The metadata writer publishes its committed format facts without a readback. */
export function publishAgentSchemaMetadata(
  db: DatabaseSync,
  metadata: ExistingAgentSchemaMeta,
): void {
  publishSqliteDatabaseAdmission(db, metadataKey, metadata);
  const schema = getAdmittedSqliteSchemaFacts(db);
  if (schema) {
    publishSqliteDatabaseAdmission(db, schemaMetadataKey(schema.admissionId), metadata);
  }
}

/** Read ownership metadata without loading runtime schema or migration owners. */
export function readExistingAgentSchemaMeta(db: DatabaseSync): ExistingAgentSchemaMeta | null {
  const schema = getAdmittedSqliteSchemaFacts(db);
  const historical =
    schema && getSqliteDatabaseAdmission(db, schemaMetadataKey(schema.admissionId));
  if (historical) {
    return historical;
  }
  const admitted =
    !schema || getSqliteDatabaseAdmission(db, schemaAdmission)?.admissionId === schema.admissionId
      ? getSqliteDatabaseAdmission(db, metadataKey)
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
  const revision = getSqliteReadScopeRevision(db);
  // Unknown DDL can recreate the same table without its row; catalog text cannot carry this proof.
  let row;
  try {
    row = db
      .prepare("SELECT role, schema_version, agent_id FROM schema_meta WHERE meta_key = 'primary'")
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
  const metadata = {
    agentId: normalizeNullableString(row.agent_id),
    role: typeof row.role === "string" ? row.role : null,
    schemaVersion: typeof row.schema_version === "number" ? row.schema_version : null,
  };
  if (
    schema &&
    (!revision || getSqliteReadScopeRevision(db) === revision) &&
    getSqliteDatabaseAdmission(db, schemaAdmission)?.admissionId === schema.admissionId
  ) {
    publishAgentSchemaMetadata(db, metadata);
  }
  return metadata;
}
