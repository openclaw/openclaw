import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import {
  assertRecordShape,
  isCurrentPlacementTurnClaim,
  normalizeEpoch,
  required,
  type WorkerSessionPlacementRecord,
  type WorkerSessionTurnClaim,
} from "./placement-record.js";
import { getRequired, query, transitionValues } from "./placement-row-codec.js";
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
  const turnClaim = current.turnClaim;
  if (turnClaim) {
    values.turn_claim_owner = turnClaim.owner;
    values.turn_claim_id = turnClaim.claimId;
    values.turn_claim_run_id = turnClaim.runId;
    values.turn_claim_generation = turnClaim.generation;
    values.turn_claim_owner_epoch = turnClaim.ownerEpoch;
  }
  assertRecordShape({
    ...current,
    state: "draining",
    workspaceBaseManifestRef: values.workspace_base_manifest_ref,
  });
  const result = executeSqliteQuerySync(
    db,
    query(db)
      .updateTable("worker_session_placements")
      .set(values)
      .where("session_id", "=", sessionId)
      .where("state", "=", "active")
      .where("transition_generation", "=", current.generation)
      .where("environment_id", "=", environmentId)
      .where("active_owner_epoch", "=", ownerEpoch),
  );
  if (result.numAffectedRows !== 1n) {
    throw new Error(`Worker session placement ${sessionId} changed during drain`);
  }
  if (input.workspaceBaseManifestRef !== undefined) {
    clearWorkerWorkspaceReconciliation(db, sessionId, input.workspaceBaseManifestRef);
    sessionChanges.emit({ agentId: current.agentId, sessionKey: current.sessionKey }, db);
  }
  const record = getRequired(db, sessionId);
  publishPlacementTurnClaimState(db, record);
  return record;
}
