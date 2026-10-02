import type { SessionEntryCurrentCheck } from "../../config/sessions/session-entry-current.types.js";
import type { WorkerSessionPlacementRecord, WorkerSessionTurnClaim } from "./placement-record.js";

export type PlacementTurnClaimReceipt = {
  placement?: WorkerSessionPlacementRecord;
  claim?: WorkerSessionTurnClaim;
};
export type PlacementTurnClaimCurrentCheck = {
  sessionEntry?: SessionEntryCurrentCheck;
  assertPlacementCurrent(placement: WorkerSessionPlacementRecord | undefined): void;
};

export type PlacementAckCursorInput = {
  claim: WorkerSessionTurnClaim;
  transcript?: number;
  liveEvent?: number;
};
