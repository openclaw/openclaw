import type { SessionMoveTarget } from "../../../packages/gateway-protocol/src/schema/session-placement.js";

export type WorkerPlacementMoveTarget = SessionMoveTarget;

export type WorkerPlacementMoveSource = {
  generation: number;
  environmentId: string;
  ownerEpoch: number;
};

export type WorkerPlacementMoveIntent = {
  operationId: string;
  sessionId: string;
  source: WorkerPlacementMoveSource;
  target: WorkerPlacementMoveTarget;
  abandonSource: boolean;
  lastError: string | null;
  createdAtMs: number;
  updatedAtMs: number;
};
