import type { DatabaseSync } from "node:sqlite";
import { sql } from "kysely";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import { trajectoryEventJsonSql } from "../trajectory/runtime-payload.js";
import { jsonPathValue } from "./database-engine/json-values.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import type { EngineConnection } from "./sql-connection.js";
import { MASKED_TRANSCRIPT_PROVIDER } from "./state-migrations.transcript-directives-transform.js";

// Restored providers were all "***", so this row list is the complete undo record.
const RESTORED_PROVIDERS_META_KEY = "historical-transcript-masked-provider-restored-v1";

type RestoredProviderRecord = {
  // Archive line owners: `<sessionId>:<generation>:<line>`.
  archiveLines: string[];
  transcriptRows: Record<string, number[]>;
};

/** Resolves masked providers per session from recorded runtime facts, cached for one run. */
export type MaskedProviderResolver = (sessionId: string) => (model: string) => string | undefined;

/**
 * Providers are restored only from facts the runtime recorded for the same session: the
 * unmasked provider of trajectory runtime events for that model. A model recorded with
 * more than one provider in the session, or not at all, stays masked.
 */
export function createMaskedProviderResolver(database: EngineConnection): MaskedProviderResolver {
  const db =
    getNodeSqliteKysely<Pick<OpenClawAgentKyselyDatabase, "trajectory_runtime_events">>(database);
  const eventJson = trajectoryEventJsonSql(database);
  const sessions = new Map<string, Map<string, string | null>>();
  return (sessionId) => (model) => {
    let providers = sessions.get(sessionId);
    if (!providers) {
      providers = new Map();
      const rows = executeSqliteQuerySync(
        database,
        db
          .selectFrom("trajectory_runtime_events")
          .select([
            jsonPathValue<unknown>(database, eventJson, sql.lit("$.modelId")).as("model"),
            jsonPathValue<unknown>(database, eventJson, sql.lit("$.provider")).as("provider"),
          ])
          .distinct()
          .where("session_id", "=", sessionId),
      ).rows;
      for (const row of rows) {
        if (
          typeof row.model !== "string" ||
          typeof row.provider !== "string" ||
          !row.provider ||
          row.provider === MASKED_TRANSCRIPT_PROVIDER
        ) {
          continue;
        }
        const recorded = providers.get(row.model);
        providers.set(
          row.model,
          recorded === undefined || recorded === row.provider ? row.provider : null,
        );
      }
      sessions.set(sessionId, providers);
    }
    return providers.get(model) ?? undefined;
  };
}

/** Appends restored rows to the undo record inside the caller's write transaction. */
export function recordRestoredProviders(
  database: DatabaseSync,
  agentId: string,
  update: (record: RestoredProviderRecord) => void,
): void {
  const db = getNodeSqliteKysely<Pick<OpenClawAgentKyselyDatabase, "schema_meta">>(database);
  const value = executeSqliteQueryTakeFirstSync(
    database,
    db
      .selectFrom("schema_meta")
      .select("app_version")
      .where("meta_key", "=", RESTORED_PROVIDERS_META_KEY),
  )?.app_version;
  const record: RestoredProviderRecord = value
    ? JSON.parse(value)
    : { archiveLines: [], transcriptRows: {} };
  update(record);
  const now = Date.now();
  const row = {
    agent_id: agentId,
    app_version: JSON.stringify(record),
    role: "agent",
    schema_version: 1,
    updated_at: now,
  };
  executeSqliteQuerySync(
    database,
    db
      .insertInto("schema_meta")
      .values({ ...row, created_at: now, meta_key: RESTORED_PROVIDERS_META_KEY })
      .onConflict((conflict) => conflict.column("meta_key").doUpdateSet(row)),
  );
}
