import { rowToSubagentRunRecord } from "../../src/agents/subagents/registry/subagent-registry.store.codec.js";
import type { SubagentRunRecord } from "../../src/agents/subagents/registry/subagent-registry.types.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../src/infra/kysely-sync.js";
import { withOpenClawStateDatabaseReadOnly } from "../../src/state/openclaw-state-db-readonly.js";
import type { DB } from "../../src/state/openclaw-state-db.generated.js";

/** Observe a child Gateway's committed native execution/outbox rows without joining its writers. */
export function readQaSubagentRuns(env: NodeJS.ProcessEnv): SubagentRunRecord[] {
  return withOpenClawStateDatabaseReadOnly(
    ({ db }) => {
      const rows = executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<Pick<DB, "subagent_runs">>(db)
          .selectFrom("subagent_runs")
          .selectAll()
          .orderBy("created_at"),
      ).rows;
      return rows.flatMap((row) => {
        const run = rowToSubagentRunRecord(row);
        return run ? [run] : [];
      });
    },
    { env },
  );
}
