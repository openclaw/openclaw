import { getNodeSqliteKysely, sqliteStringSet } from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import type { DB as StateDatabase } from "../../state/openclaw-state-db.generated.js";
import { WORKER_ENVIRONMENT_TERMINAL_STATES } from "./state.js";
import { executeWorkerEnvironmentWrite } from "./store-write.js";
import type { WorkerEnvironmentMutationInput } from "./store.types.js";

export function pruneTerminalWorkerEnvironments(
  db: EngineConnection,
  input: WorkerEnvironmentMutationInput<"pruneTerminalEnvironments">,
): string[] {
  const query = getNodeSqliteKysely<StateDatabase>(db);
  const eligible = query
    .selectFrom("worker_environments")
    .select("environment_id")
    .where("environment_id", "in", sqliteStringSet(input.environmentIds))
    .where("state", "in", WORKER_ENVIRONMENT_TERMINAL_STATES)
    .where("state_changed_at_ms", "<=", input.cutoffMs)
    .where((eb) => eb.or([eb("state", "!=", "orphaned"), eb("preparation_key", "is", null)]))
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("worker_session_placements")
            .select("session_id")
            .whereRef("environment_id", "=", "worker_environments.environment_id"),
        ),
      ),
    )
    .orderBy("state_changed_at_ms", "asc")
    .orderBy("environment_id", "asc")
    .limit(input.limit);
  // Selection and deletion share the writer transaction; referenced rows never consume the limit.
  return executeWorkerEnvironmentWrite(
    db,
    query
      .deleteFrom("worker_environments")
      .where("environment_id", "in", eligible)
      .returning("environment_id"),
  ).rows.map((row) => row.environment_id);
}
