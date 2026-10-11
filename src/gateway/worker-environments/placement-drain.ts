import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import {
  isCurrentPlacementTurnClaim,
  normalizeEpoch,
  required,
  type WorkerSessionPlacementRecord,
  type WorkerSessionTurnClaim,
} from "./placement-record.js";
import {
  fromRow,
  getRequired,
  query,
  transitionValues,
  turnClaimValues,
} from "./placement-row-codec.js";
import { publishPlacementTurnClaimState } from "./placement-turn-authority.js";
import { clearWorkerWorkspaceReconciliation } from "./placement-workspace-journal.js";
import { hasWorkerWorkspacePendingResult } from "./placement-workspace-result.js";

export function drainWorkerSessionPlacement(
  db: DatabaseSync,
  input: {
    sessionId: string;
    environmentId: string;
    ownerEpoch: number;
    expectedGeneration: number;
    expectedUpdatedAtMs?: number;
    workspaceBaseManifestRef?: string;
    allowPendingWorkspaceResult?: boolean;
    requireUnclaimed?: true;
    expectedTurnClaim?: WorkerSessionTurnClaim;
  },
  nowMs: number,
): WorkerSessionPlacementRecord {
  const sessionId = required(input.sessionId, "session id");
  const environmentId = required(input.environmentId, "environment id");
  const ownerEpoch = normalizeEpoch(input.ownerEpoch, "active owner epoch");
  const current = getRequired(db, sessionId);
  if (
    current.state !== "active" ||
    current.generation !== input.expectedGeneration ||
    current.environmentId !== environmentId ||
    current.activeOwnerEpoch !== ownerEpoch
  ) {
    throw new Error(`Cannot drain stale worker placement for session ${sessionId}`);
  }
  if (
    input.expectedUpdatedAtMs !== undefined &&
    current.updatedAtMs !== input.expectedUpdatedAtMs
  ) {
    throw new Error(`Cannot drain changed worker placement activity for session ${sessionId}`);
  }
  if (!input.allowPendingWorkspaceResult && hasWorkerWorkspacePendingResult(db, sessionId)) {
    throw new Error(`Cannot drain session ${sessionId} with a pending cloud workspace result`);
  }
  if (input.requireUnclaimed && current.turnClaim) {
    throw new Error(`Cannot drain session ${sessionId} during an active turn`);
  }
  if (input.expectedTurnClaim && !isCurrentPlacementTurnClaim(current, input.expectedTurnClaim)) {
    throw new Error(`Cannot drain stale worker turn for session ${sessionId}`);
  }
  // Draining closes new admission first. The already-admitted worker may
  // finish under its old claim before reconciliation advances ownership.
  const values = transitionValues(
    current,
    "draining",
    input.workspaceBaseManifestRef === undefined
      ? {}
      : { workspaceBaseManifestRef: input.workspaceBaseManifestRef },
    nowMs,
  );
  Object.assign(values, turnClaimValues(current.turnClaim));
  const result = executeSqliteQuerySync(
    db,
    query(db)
      .updateTable("worker_session_placements")
      .set(values)
      .where("session_id", "=", sessionId)
      .where("state", "=", "active")
      .where("transition_generation", "=", current.generation)
      .where("environment_id", "=", environmentId)
      .where("active_owner_epoch", "=", ownerEpoch)
      .returningAll(),
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Worker session placement ${sessionId} changed during drain`);
  }
  if (input.workspaceBaseManifestRef !== undefined) {
    clearWorkerWorkspaceReconciliation(db, sessionId, input.workspaceBaseManifestRef);
    sessionChanges.emit({ agentId: current.agentId, sessionKey: current.sessionKey }, db);
  }
  const record = fromRow(row);
  publishPlacementTurnClaimState(db, record);
  return record;
}
