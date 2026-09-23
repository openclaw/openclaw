import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { VERSION } from "../version.js";
import type { DB as OpenClawAgentKyselyDatabase } from "./openclaw-agent-db.generated.js";

type OpenClawAgentMetadataDatabase = Pick<OpenClawAgentKyselyDatabase, "schema_meta">;

export function persistAgentSchemaMetadata(
  db: DatabaseSync,
  agentId: string,
  targetVersion: number,
): void {
  const now = Date.now();
  const metadata = {
    role: "agent" as const,
    schema_version: targetVersion,
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
              eb("schema_meta.app_version", "is", null),
              eb("schema_meta.app_version", "!=", VERSION),
              eb("schema_meta.agent_id", "!=", agentId),
            ]),
          ),
      ),
  );
}
