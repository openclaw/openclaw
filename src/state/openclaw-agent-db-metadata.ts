import type { DatabaseSync } from "node:sqlite";
import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import {
  getSqliteDatabaseAdmission,
  publishSqliteDatabaseAdmission,
  type SqliteDatabaseAdmissionKey,
} from "../infra/sqlite-database-admission.js";
import { schemaAdmission } from "../infra/sqlite-schema-admission.js";
import { getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import { classifySqliteTableReadError, tableExists } from "./openclaw-state-db-schema-helpers.js";

export type ExistingAgentSchemaMeta = {
  agentId: string | null;
  role: string | null;
  schemaVersion: number | null;
};

export const agentSchemaMetadataKey: SqliteDatabaseAdmissionKey<ExistingAgentSchemaMeta> = {
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
  return { name: `agent.schema-metadata:${admissionId}`, read: agentSchemaMetadataKey.read };
}

/** The metadata writer publishes its committed format facts without a readback. */
export function publishAgentSchemaMetadata(
  db: DatabaseSync,
  metadata: ExistingAgentSchemaMeta,
): void {
  publishSqliteDatabaseAdmission(db, agentSchemaMetadataKey, metadata);
  const schema = getAdmittedSqliteSchemaFacts(db);
  if (schema) {
    publishSqliteDatabaseAdmission(db, schemaMetadataKey(schema.admissionId), metadata);
  }
}

type AgentSchemaMetaWithAppVersion = ExistingAgentSchemaMeta & { appVersion: string | null };

/** Read ownership metadata without loading runtime schema or migration owners. */
export function readExistingAgentSchemaMeta(
  db: DatabaseSync,
  options: { includeAppVersion: true },
): AgentSchemaMetaWithAppVersion | null;
export function readExistingAgentSchemaMeta(db: DatabaseSync): ExistingAgentSchemaMeta | null;
export function readExistingAgentSchemaMeta(
  db: DatabaseSync,
  options?: { includeAppVersion: true },
): ExistingAgentSchemaMeta | AgentSchemaMetaWithAppVersion | null {
  const schema = getAdmittedSqliteSchemaFacts(db);
  const historical =
    !options?.includeAppVersion &&
    schema &&
    getSqliteDatabaseAdmission(db, schemaMetadataKey(schema.admissionId));
  if (historical) {
    return historical;
  }
  const admitted =
    !options?.includeAppVersion &&
    (!schema || getSqliteDatabaseAdmission(db, schemaAdmission)?.admissionId === schema.admissionId)
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
        options?.includeAppVersion
          ? "SELECT role, schema_version, agent_id, app_version FROM schema_meta WHERE meta_key = 'primary'"
          : "SELECT role, schema_version, agent_id FROM schema_meta WHERE meta_key = 'primary'",
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
  const metadata = {
    agentId: normalizeNullableString(row.agent_id),
    role: typeof row.role === "string" ? row.role : null,
    schemaVersion: typeof row.schema_version === "number" ? row.schema_version : null,
  };
  if (
    schema &&
    getAdmittedSqliteSchemaFacts(db) === schema &&
    getSqliteDatabaseAdmission(db, schemaAdmission)?.admissionId === schema.admissionId
  ) {
    publishAgentSchemaMetadata(db, metadata);
  }
  // App version can change without DDL; write admission must read it from the current row.
  return options?.includeAppVersion
    ? { ...metadata, appVersion: typeof row.app_version === "string" ? row.app_version : null }
    : metadata;
}
