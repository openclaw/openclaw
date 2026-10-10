import type { DatabaseSync } from "node:sqlite";
import { sql } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { extractSqliteTableSchema } from "../../infra/sqlite-schema-sql.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db-contract.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import { OPENCLAW_STATE_SCHEMA_SQL } from "../../state/openclaw-state-schema.js";
import { isWorkshopChangeAction, type WorkshopChangeAction } from "./skill-versions.js";

const WORKSHOP_ACTORS = ["agent", "review", "curator", "user"] as const;
export type WorkshopActor = (typeof WORKSHOP_ACTORS)[number];

function isWorkshopActor(value: string): value is WorkshopActor {
  return WORKSHOP_ACTORS.some((actor) => actor === value);
}

export type WorkshopChange = {
  id: string;
  agentId: string;
  skillName: string;
  action: WorkshopChangeAction;
  actor: WorkshopActor;
  /** One short human line, e.g. "patched step 3" or "created: <description>". */
  summary: string;
  /** Snapshot taken before the change; absent when nothing existed to snapshot. */
  versionId?: string;
  sessionKey?: string;
  runId?: string;
  createdAtMs: number;
};

type ChangesDatabase = Pick<DB, "skill_workshop_changes">;

const MAX_CHANGES_PER_AGENT = 500;

export type WorkshopChangesQuery = {
  agentId: string;
  limit: number;
  beforeMs?: number;
  runId?: string;
};

/** Appends one change and keeps the newest rows per agent. */
export function recordWorkshopChangeInDatabase(
  database: OpenClawStateDatabase,
  change: WorkshopChange,
): void {
  const { db } = database;
  // sqlite-allow-raw -- Canonical feature-owned additive DDL; rows use Kysely.
  // Canonical table + index are adjacent in the schema; the index line ends the slice.
  db.exec(
    extractSqliteTableSchema(OPENCLAW_STATE_SCHEMA_SQL, "skill_workshop_changes", {
      endMarker: "ON skill_workshop_changes(agent_id, created_at_ms);",
    }),
  );
  const kysely = getNodeSqliteKysely<ChangesDatabase>(db);
  executeSqliteQuerySync(
    db,
    kysely.insertInto("skill_workshop_changes").values({
      change_id: change.id,
      agent_id: change.agentId,
      skill_name: change.skillName,
      action: change.action,
      actor: change.actor,
      summary: change.summary,
      version_id: change.versionId ?? null,
      session_key: change.sessionKey ?? null,
      run_id: change.runId ?? null,
      created_at_ms: change.createdAtMs,
    }),
  );
  executeSqliteQuerySync(
    db,
    kysely
      .deleteFrom("skill_workshop_changes")
      .where("agent_id", "=", change.agentId)
      .where(
        "change_id",
        "not in",
        kysely
          .selectFrom("skill_workshop_changes")
          .select("change_id")
          .where("agent_id", "=", change.agentId)
          .orderBy("created_at_ms", "desc")
          .orderBy(sql`rowid`, "desc")
          .limit(MAX_CHANGES_PER_AGENT),
      ),
  );
}

/** Newest first; a database that never recorded a change has no table yet. */
export function listWorkshopChangesInDatabase(
  db: DatabaseSync,
  query: WorkshopChangesQuery,
): WorkshopChange[] {
  if (!tableExists(db, "skill_workshop_changes")) {
    return [];
  }
  const kysely = getNodeSqliteKysely<ChangesDatabase>(db);
  let select = kysely
    .selectFrom("skill_workshop_changes")
    .selectAll()
    .where("agent_id", "=", query.agentId);
  if (query.beforeMs !== undefined) {
    select = select.where("created_at_ms", "<", query.beforeMs);
  }
  if (query.runId !== undefined) {
    select = select.where("run_id", "=", query.runId);
  }
  const rows = executeSqliteQuerySync(
    db,
    select
      .orderBy("created_at_ms", "desc")
      .orderBy(sql`rowid`, "desc")
      .limit(query.limit),
  ).rows;
  return rows.flatMap((row) => {
    // The table CHECK constraints admit only these values; skip anything a future writer adds.
    if (!isWorkshopChangeAction(row.action) || !isWorkshopActor(row.actor)) {
      return [];
    }
    const change: WorkshopChange = {
      id: row.change_id,
      agentId: row.agent_id,
      skillName: row.skill_name,
      action: row.action,
      actor: row.actor,
      summary: row.summary,
      createdAtMs: row.created_at_ms,
      ...(row.version_id ? { versionId: row.version_id } : {}),
      ...(row.session_key ? { sessionKey: row.session_key } : {}),
      ...(row.run_id ? { runId: row.run_id } : {}),
    };
    return [change];
  });
}
