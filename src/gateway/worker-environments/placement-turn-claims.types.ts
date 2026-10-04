import type { SessionEntryCurrentCheck } from "../../config/sessions/session-entry-current.types.js";
import type { WorkerPlacementMoveIntent } from "./placement-move-intent.js";
import type { WorkerSessionPlacementRecord, WorkerSessionTurnClaim } from "./placement-record.js";
import type { WorkerWorkspacePendingResult } from "./placement-workspace-result.types.js";

export type PlacementTurnClaimReceipt = {
  placement?: WorkerSessionPlacementRecord;
  claim?: WorkerSessionTurnClaim;
  closedClaim?: WorkerSessionTurnClaim;
  environmentActivation?: { environmentId: string; lastActivatedAtMs: number };
  workspaceResult?: WorkerWorkspacePendingResult | null;
  placementMove?: WorkerPlacementMoveIntent | null;
};
export type PlacementTurnClaimCurrentCheck = {
  sessionEntry?: SessionEntryCurrentCheck;
  assertPlacementCurrent(
    placement: WorkerSessionPlacementRecord | undefined,
    move?: WorkerPlacementMoveIntent | null,
  ): void;
};

export type PlacementAckCursorInput = {
  claim: WorkerSessionTurnClaim;
  transcript?: number;
  liveEvent?: number;
};
