import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { VERSION } from "../version.js";
import { publishAgentSchemaMetadata } from "./openclaw-agent-db-metadata.js";
import type { DB as OpenClawAgentKyselyDatabase } from "./openclaw-agent-db.generated.js";
import { ensureColumn, tableHasColumn } from "./openclaw-state-db-schema-helpers.js";

// The additive admission metadata is deliberately independent of canonical application DDL.
type OpenClawAgentMetadataDatabase = {
  schema_meta: OpenClawAgentKyselyDatabase["schema_meta"] & { min_reader: number | null };
};

export function persistAgentSchemaMetadata(
  db: DatabaseSync,
  agentId: string,
  targetVersion: number,
  minReader = targetVersion,
): void {
  // Creation and migration callers already hold the schema writer transaction.
  const lowerFloor = minReader < targetVersion;
  if (lowerFloor) {
    ensureColumn(db, "schema_meta", "min_reader INTEGER");
  }
  const hasFloor = lowerFloor || tableHasColumn(db, "schema_meta", "min_reader");
  const publishedMinReader = lowerFloor ? minReader : null;
  const now = Date.now();
  const metadata = {
    role: "agent" as const,
    schema_version: targetVersion,
    ...(hasFloor ? { min_reader: publishedMinReader } : {}),
    agent_id: agentId,
    app_version: VERSION,
  };
  executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<OpenClawAgentMetadataDatabase>(db)
      .insertInto("schema_meta")
      .values({ meta_key: "primary", ...metadata, created_at: now, updated_at: now })
      .onConflict((conflict) =>
        conflict
          .column("meta_key")
          .doUpdateSet({ ...metadata, updated_at: now })
          // updated_at records when schema metadata last changed, not when
          // the database was last opened; unconditional bumps make every
          // open dirty the row and defeat no-change backup detection.
          .where((eb) =>
            eb.or([
              eb("schema_meta.schema_version", "!=", targetVersion),
              ...(hasFloor ? [eb("schema_meta.min_reader", "is not", publishedMinReader)] : []),
              eb("schema_meta.app_version", "is", null),
              eb("schema_meta.app_version", "!=", VERSION),
              eb("schema_meta.agent_id", "!=", agentId),
            ]),
          ),
      ),
  );
  publishAgentSchemaMetadata(db, {
    role: "agent",
    schemaVersion: targetVersion,
    ...(lowerFloor ? { minReader } : {}),
    agentId,
  });
}
