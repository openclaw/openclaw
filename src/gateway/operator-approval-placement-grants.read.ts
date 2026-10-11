import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB } from "../state/openclaw-state-db.generated.js";

export type PlacementGrantReadInput = {
  agentId: string;
  sessionKey: string;
  sessionId?: string;
  approvalId?: string;
  approvalIdsBySessionId?: Record<string, string>;
};

/** One snapshot covers binding selection, attachment, and the durable parent decision. */
export function readPlacementGrantRows(db: DatabaseSync, input: PlacementGrantReadInput) {
  const stateDb = getNodeSqliteKysely<DB>(db);
  const parents = stateDb
    .selectFrom((eb) =>
      eb
        .fn<{ key: string; value: string }>("json_each", [
          eb.val(JSON.stringify(input.approvalIdsBySessionId ?? {})),
        ])
        .as("requested"),
    )
    .select(["requested.key", "requested.value"])
    .as("parents");
  let query = stateDb
    .selectFrom("worker_session_placements as p")
    .leftJoin("worker_environments as e", "e.environment_id", "p.environment_id")
    .leftJoin(parents, "parents.key", "p.session_id")
    .leftJoin("operator_approvals as a", (join) =>
      input.approvalId
        ? join.on("a.approval_id", "=", input.approvalId)
        : join.onRef("a.approval_id", "=", "parents.value"),
    )
    .selectAll("p")
    .select([
      "e.state as environment_state",
      "e.node_device_id",
      "e.owner_epoch",
      "e.attached_session_ids_json",
      "a.approval_id",
      "a.status as approval_status",
      "a.decision",
      "a.runtime_epoch",
    ]);
  query = input.sessionId
    ? query.where("p.session_id", "=", input.sessionId)
    : query
        .where("p.agent_id", "=", input.agentId)
        .where("p.session_key", "=", input.sessionKey)
        .where("p.state", "=", "active")
        .where("p.execution_mode", "=", "remote-exec");
  return executeSqliteQuerySync(db, query.limit(2)).rows;
}

export type PlacementGrantRows = ReturnType<typeof readPlacementGrantRows>;
