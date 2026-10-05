import type { DatabaseSync } from "node:sqlite";
import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import {
  getSqliteReadOperationRevision,
  type SqliteReadOperationRevision,
} from "../infra/sqlite-schema-facts.js";
import { classifySqliteTableReadError, tableExists } from "./openclaw-state-db-schema-helpers.js";

export type ExistingAgentSchemaMeta = {
  agentId: string | null;
  role: string | null;
  schemaVersion: number | null;
};

const admittedMetadata = new WeakMap<
  DatabaseSync,
  SqliteReadOperationRevision & { metadata: ExistingAgentSchemaMeta }
>();

/** Read ownership metadata without loading runtime schema or migration owners. */
export function readExistingAgentSchemaMeta(db: DatabaseSync): ExistingAgentSchemaMeta | null {
  const revision = getSqliteReadOperationRevision(db);
  const admitted = admittedMetadata.get(db);
  if (
    revision &&
    admitted?.schema === revision.schema &&
    admitted.dataVersion === revision.dataVersion &&
    admitted.mutationRevision === revision.mutationRevision
  ) {
    return { ...admitted.metadata };
  }
  if (!tableExists(db, "schema_meta")) {
    return null;
  }
  // Schema admission runs in native readers before query-builder runtimes load.
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
  // Ownership is row data: schema facts alone cannot witness a foreign owner change.
  if (revision) {
    admittedMetadata.set(db, { ...revision, metadata: { ...metadata } });
  }
  return metadata;
}
