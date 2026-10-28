import {
  MEDIA_ROWS_MIGRATION_META_KEY,
  OPENCLAW_AGENT_SCHEMA_VERSION,
} from "../state/openclaw-agent-db-contract.js";
import { retainOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import { requireNativeDatabaseFile } from "./database-engine/physical-facts.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "./kysely-sync.js";
import type { EngineConnection } from "./sql-connection.js";
import { mediaRowsNeedMigration } from "./state-migrations.media-persistence-database.js";
import { transformMediaArchiveContent } from "./state-migrations.media-persistence-transform.js";
import { transcriptDirectiveArchivesNeedMigration } from "./state-migrations.transcript-directives-archives.js";

export function hasMediaRowsMigrationReceipt(database: EngineConnection): boolean {
  const db = getNodeSqliteKysely<Pick<OpenClawAgentKyselyDatabase, "schema_meta">>(database);
  return Boolean(
    executeSqliteQueryTakeFirstSync(
      database,
      db
        .selectFrom("schema_meta")
        .select("schema_version")
        .where("meta_key", "=", MEDIA_ROWS_MIGRATION_META_KEY),
    ),
  );
}

export async function inspectPostgresMediaPersistence(params: {
  agentId: string;
  env: NodeJS.ProcessEnv;
  pathname: string;
  migratedFromVersion?: number;
}) {
  const retained = retainOpenClawAgentDatabaseReadOnly({
    agentId: params.agentId,
    path: params.pathname,
    env: params.env,
  });
  if (!retained.found) {
    throw new Error(`Agent database is unavailable for media inspection: ${params.pathname}`);
  }
  try {
    const database = retained.database.db;
    const initialVersion = params.migratedFromVersion ?? OPENCLAW_AGENT_SCHEMA_VERSION;
    const deferred = initialVersion < OPENCLAW_AGENT_SCHEMA_VERSION;
    if (
      !deferred &&
      ((!hasMediaRowsMigrationReceipt(database) &&
        mediaRowsNeedMigration(database, params.pathname)) ||
        (await transcriptDirectiveArchivesNeedMigration(
          database,
          { generation: "", sessionId: "" },
          transformMediaArchiveContent,
        )))
    ) {
      // Healthy PostgreSQL history needs no native schema or backup work.
      requireNativeDatabaseFile("postgres", "repair");
    }
    return {
      deferred,
      rewrittenSessions: 0,
      rewrittenTrajectoryRows: 0,
      rewrittenArchives: 0,
      warnings: [],
      initialVersion,
      finalVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
    };
  } finally {
    retained.claim.release();
  }
}
