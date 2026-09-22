import type { FlowRecordPatch } from "./task-flow-registry.records.js";
import { isTerminalTaskFlow, type TaskFlowRecord } from "./task-flow-registry.types.js";

const TASK_FLOW_RETENTION_MS = 7 * 24 * 60 * 60_000;

export type TaskFlowMaintenanceAction =
  | { kind: "repair" | "cancel"; patch: FlowRecordPatch }
  | { kind: "prune" };

/** Repair and cancellation each consume a pass before retention can remove the flow. */
export function resolveTaskFlowMaintenanceAction(
  flow: TaskFlowRecord,
  now: number,
  hasPendingTasks: () => boolean,
): TaskFlowMaintenanceAction | undefined {
  if (
    flow.syncMode === "task_mirrored" &&
    isTerminalTaskFlow(flow) &&
    flow.endedAt != null &&
    flow.endedAt >= flow.createdAt &&
    flow.updatedAt > flow.endedAt
  ) {
    return { kind: "repair", patch: { updatedAt: flow.endedAt } };
  }
  if (flow.syncMode === "managed" && flow.cancelRequestedAt != null && !isTerminalTaskFlow(flow)) {
    if (hasPendingTasks()) {
      return undefined;
    }
    const endedAt = Math.max(now, flow.updatedAt, flow.cancelRequestedAt);
    return {
      kind: "cancel",
      patch: {
        status: "cancelled",
        blockedTaskId: null,
        blockedSummary: null,
        waitJson: null,
        endedAt,
        updatedAt: endedAt,
      },
    };
  }
  if (
    isTerminalTaskFlow(flow) &&
    now - (flow.endedAt ?? flow.updatedAt ?? flow.createdAt) >= TASK_FLOW_RETENTION_MS &&
    !hasPendingTasks()
  ) {
    return { kind: "prune" };
  }
  return undefined;
}

export type TaskFlowMaintenanceInput = {
  flowId: string;
  expectedRevision: number;
  action: TaskFlowMaintenanceAction["kind"];
  now: number;
};

export type TaskFlowMaintenanceOutcome =
  | "reconciled"
  | "pruned"
  | "unchanged"
  | "revision_conflict";
