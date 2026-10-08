import type { DatabaseSync } from "node:sqlite";
import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import { registerNodeSqliteDisposeCallback } from "../infra/kysely-sync-cache-state.js";
import {
  getSqliteReadScopeRevision,
  type SqliteReadScopeRevision,
} from "../infra/sqlite-schema-facts.js";
import { classifySqliteTableReadError, tableExists } from "./openclaw-state-db-schema-helpers.js";

export type ExistingAgentSchemaMeta = {
  agentId: string | null;
  role: string | null;
  schemaVersion: number | null;
};

const admittedMetadata = new WeakMap<
  DatabaseSync,
  { revision: SqliteReadScopeRevision; metadata: ExistingAgentSchemaMeta }
>();

/** Read ownership metadata without loading runtime schema or migration owners. */
export function readExistingAgentSchemaMeta(db: DatabaseSync): ExistingAgentSchemaMeta | null {
  const revision = getSqliteReadScopeRevision(db);
  const admitted = admittedMetadata.get(db);
  if (revision && admitted?.revision === revision) {
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
  // A fresh snapshot with the same data/mutation revisions can reuse these admitted facts.
  if (revision) {
    if (!admitted) {
      // Weak reader references can keep closed keys alive through a long microtask drain.
      const unregister = registerNodeSqliteDisposeCallback(db, () => {
        admittedMetadata.delete(db);
        unregister();
      });
    }
    admittedMetadata.set(db, { revision, metadata: { ...metadata } });
  }
  return metadata;
}
