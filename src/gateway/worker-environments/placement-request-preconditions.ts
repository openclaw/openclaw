import { matchesWorkerPlacementTarget } from "./placement-reclaim-contract.js";
import {
  normalizeWorkerPlacementExecutionMode,
  type WorkerSessionPlacementDispatchIdentity,
  type WorkerSessionPlacementRecord,
} from "./placement-record.js";

export function assertWorkerPlacementDispatchSource(
  current: WorkerSessionPlacementRecord | undefined,
  request: WorkerSessionPlacementDispatchIdentity,
): void {
  if (
    current &&
    current.state !== "local" &&
    current.state !== "reclaimed" &&
    current.state !== "failed"
  ) {
    throw new Error(`Cannot dispatch session ${request.sessionId} from placement ${current.state}`);
  }
  if (
    request.expectedPlacement &&
    (!current ||
      !matchesWorkerPlacementTarget(current, request.expectedPlacement) ||
      current.executionMode !== normalizeWorkerPlacementExecutionMode(request.executionMode) ||
      (current.state !== "reclaimed" && current.state !== "failed") ||
      current.turnClaim)
  ) {
    throw new Error(`Worker placement ${request.sessionId} changed before redispatch`);
  }
}
