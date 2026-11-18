import type { NativeWorkerLossRecovery } from "../../agents/harness/native-session/worker-placement.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import type { WorkerEnvironmentRecord } from "./environment-record.js";
import { find, query } from "./placement-row-codec.js";

/** The environment writer records provider proof before retiring its exact attachment. */
export function recordConfirmedWorkerLossInDatabase(
  db: EngineConnection,
  environment: WorkerEnvironmentRecord,
  nowMs: number,
): void {
  const [sessionId] = environment.attachedSessionIds;
  if (
    environment.state !== "attached" ||
    environment.attachedSessionIds.length !== 1 ||
    !sessionId
  ) {
    return;
  }
  const placement = find(db, sessionId);
  if (
    !placement ||
    placement.environmentId !== environment.environmentId ||
    placement.activeOwnerEpoch !== environment.ownerEpoch
  ) {
    return;
  }
  const recovery: NativeWorkerLossRecovery = {
    version: 1,
    predecessor: {
      agentId: placement.agentId,
      sessionKey: placement.sessionKey,
      sessionId: placement.sessionId,
      environmentId: environment.environmentId,
      ownerEpoch: environment.ownerEpoch,
      ...(environment.retention
        ? { retentionOwnerBinding: environment.retention.policy.ownerBinding }
        : {}),
    },
  };
  // A second activated replacement may die before its native binding commits.
  // One predecessor cannot prove an older binding in that case; native recovery
  // deliberately refuses rather than inventing a transitive lineage.
  executeSqliteQuerySync(
    db,
    query(db)
      .updateTable("worker_session_placements")
      .set({ confirmed_loss_recovery_json: JSON.stringify(recovery), updated_at_ms: nowMs })
      .where("session_id", "=", placement.sessionId)
      .where("environment_id", "=", environment.environmentId)
      .where("active_owner_epoch", "=", environment.ownerEpoch)
      .where("transition_generation", "=", placement.generation),
  );
}
