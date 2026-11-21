import {
  SESSION_PLACEMENT_STATES,
  type SessionPlacementState as WorkerSessionPlacementState,
} from "../../../packages/gateway-protocol/src/schema/session-placement-state.js";

export type { WorkerSessionPlacementState };

const WORKER_SESSION_PLACEMENT_TRANSITIONS = {
  local: ["requested", "failed"],
  requested: ["provisioning", "failed"],
  provisioning: ["syncing", "failed"],
  syncing: ["starting", "failed"],
  starting: ["active", "failed"],
  active: ["draining"],
  draining: ["reconciling"],
  reconciling: ["local", "reclaimed", "failed"],
  reclaimed: ["requested"],
  failed: ["local", "requested"],
} as const satisfies Record<WorkerSessionPlacementState, readonly WorkerSessionPlacementState[]>;

export function parseWorkerSessionPlacementState(value: string): WorkerSessionPlacementState {
  if ((SESSION_PLACEMENT_STATES as readonly string[]).includes(value)) {
    return value as WorkerSessionPlacementState;
  }
  throw new Error(`Invalid worker session placement state: ${value}`);
}

export function canTransitionWorkerSessionPlacement(
  from: WorkerSessionPlacementState,
  to: WorkerSessionPlacementState,
): boolean {
  return WORKER_SESSION_PLACEMENT_TRANSITIONS[from].some((candidate) => candidate === to);
}
