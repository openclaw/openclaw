import type { WorkerPlacementMoveIntent } from "./placement-move-intent.types.js";
import type { WorkerSessionPlacementRecord } from "./placement-record.js";
import type { WorkerSessionPlacementRetirement } from "./placement-retirement.js";
import type { WorkerEnvironmentNativePatch } from "./store-projection.js";

export type PlacementLifecycleReceipt = {
  sessionId: string;
  placement?: WorkerSessionPlacementRecord;
  intent?: WorkerPlacementMoveIntent;
  joined?: boolean;
  changed?: boolean;
  retired?: WorkerSessionPlacementRetirement["expectedState"];
  moveRemoved?: boolean;
  environment?: { environmentId: string; patch: WorkerEnvironmentNativePatch };
};
