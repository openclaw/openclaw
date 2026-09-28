import type { WorkerPlacementMoveSource } from "./placement-move-intent.js";
import { matchesWorkerPlacementTarget } from "./placement-reclaim-contract.js";
import {
  isForceAbandonedWorkerPlacement,
  normalizeWorkerPlacementExecutionMode,
  type WorkerSessionPlacementDispatchIdentity,
  type WorkerSessionPlacementRecord,
} from "./placement-record.js";

export function assertWorkerPlacementMoveSource(
  current: WorkerSessionPlacementRecord | undefined,
  request: { sessionId: string; source: WorkerPlacementMoveSource; abandonSource?: true },
  options: { allowDraining?: true } = {},
): void {
  const { source, sessionId } = request;
  if (
    !current ||
    current.environmentId !== source.environmentId ||
    current.activeOwnerEpoch !== source.ownerEpoch ||
    !(
      (options.allowDraining && current.state === "draining") ||
      (current.generation === source.generation &&
        (current.state === "active" ||
          (request.abandonSource && isForceAbandonedWorkerPlacement(current))))
    )
  ) {
    throw new Error(`Cannot move stale worker placement for session ${sessionId}`);
  }
}

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
