import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db.js";

type SkillUsageDatabase = Pick<DB, "skill_usage">;

export type PreparedSkillUsage = {
  skillFile: string;
  skillKey: string;
  skillName: string;
  skillSource: string;
  agentId?: string;
  ts: number;
};

export type SkillUsageRow = { skillFile: string; useCount: number; lastUsedAtMs: number };

export function readSkillUsageInDatabase(
  database: OpenClawStateDatabase,
  skillFiles: readonly string[],
): SkillUsageRow[] {
  if (skillFiles.length === 0) {
    return [];
  }
  const kysely = getNodeSqliteKysely<SkillUsageDatabase>(database.db);
  return executeSqliteQuerySync(
    database.db,
    kysely
      .selectFrom("skill_usage")
      .select(["skill_file", "last_used_at_ms", "use_count"])
      .where("skill_file", "in", skillFiles),
  ).rows.map((row) => ({
    skillFile: row.skill_file,
    useCount: row.use_count,
    lastUsedAtMs: row.last_used_at_ms,
  }));
}

export function recordSkillUsageInDatabase(
  database: OpenClawStateDatabase,
  event: PreparedSkillUsage,
) {
  const kysely = getNodeSqliteKysely<SkillUsageDatabase>(database.db);
  executeSqliteQuerySync(
    database.db,
    kysely
      .insertInto("skill_usage")
      .values({
        skill_file: event.skillFile,
        skill_key: event.skillKey,
        skill_name: event.skillName,
        skill_source: event.skillSource,
        first_used_at_ms: event.ts,
        last_used_at_ms: event.ts,
        use_count: 1,
        last_agent_id: event.agentId ?? null,
      })
      .onConflict((conflict) =>
        conflict.column("skill_file").doUpdateSet((eb) => ({
          skill_key: event.skillKey,
          skill_name: event.skillName,
          skill_source: event.skillSource,
          first_used_at_ms: eb.fn<number>("min", [eb.ref("first_used_at_ms"), eb.val(event.ts)]),
          last_used_at_ms: eb.fn<number>("max", [eb.ref("last_used_at_ms"), eb.val(event.ts)]),
          use_count: eb("use_count", "+", 1),
          last_agent_id: eb
            .case()
            .when("last_used_at_ms", "<=", event.ts)
            .then(event.agentId ?? null)
            .else(eb.ref("last_agent_id"))
            .end(),
        })),
      ),
  );
}
