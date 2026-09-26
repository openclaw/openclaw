import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import type { TaskRecord } from "./task-registry.types.js";

export type TaskFlowCancellationResult = {
  found: boolean;
  cancelled: boolean;
  reason?: string;
  flow?: TaskFlowRecord;
  tasks?: TaskRecord[];
};

export type TaskFlowCancellationSelection = Pick<
  TaskFlowRecord,
  "flowId" | "ownerKey" | "createdAt" | "controllerId" | "syncMode"
>;

export type TaskFlowCancellationRequest = {
  cfg: OpenClawConfig;
  flowId: string;
  expectedFlow?: TaskFlowCancellationSelection & Pick<TaskFlowRecord, "revision">;
};

export function captureTaskFlowCancellationSelection(
  flow: TaskFlowCancellationSelection,
): TaskFlowCancellationSelection {
  return {
    flowId: flow.flowId,
    ownerKey: flow.ownerKey,
    createdAt: flow.createdAt,
    controllerId: flow.controllerId,
    syncMode: flow.syncMode,
  };
}

export type TaskFlowCancellationInput = {
  selected: TaskFlowCancellationSelection;
  phase: "request" | "finalize";
  expectedRevision: number;
  now: number;
};

export type TaskFlowCancellationReceipt = TaskFlowCancellationResult & {
  dispatch?: TaskRecord[];
};

export function matchesTaskFlowCancellationSelection(
  flow: TaskFlowCancellationSelection | undefined,
  selected: TaskFlowCancellationSelection,
): boolean {
  return Boolean(
    flow &&
    flow.flowId === selected.flowId &&
    flow.ownerKey === selected.ownerKey &&
    flow.createdAt === selected.createdAt &&
    flow.controllerId === selected.controllerId &&
    flow.syncMode === selected.syncMode,
  );
}
