import { listTasksForFlowId } from "./runtime-internal.js";
import {
  listTaskFlowAuditFindings,
  summarizeTaskFlowAuditFindings,
  type TaskFlowAuditSummary,
} from "./task-flow-registry.audit.js";
import {
  deleteTaskFlowRecordById,
  deriveTaskFlowStatusFromTask,
  getTaskFlowById,
  listTaskFlowRecords,
  updateFlowRecordByIdExpectedRevision,
} from "./task-flow-registry.js";
import type { TaskFlowRecord, TaskFlowStatus } from "./task-flow-registry.types.js";
import type { TaskRecord } from "./task-registry.types.js";

const TASK_FLOW_RETENTION_MS = 7 * 24 * 60 * 60_000;

export type TaskFlowRegistryMaintenanceSummary = {
  reconciled: number;
  pruned: number;
};

function isTerminalFlow(flow: TaskFlowRecord): boolean {
  return (
    flow.status === "succeeded" ||
    flow.status === "failed" ||
    flow.status === "cancelled" ||
    flow.status === "lost"
  );
}

function hasActiveLinkedTasks(flowId: string): boolean {
  return listTasksForFlowId(flowId).some(
    (task) => task.status === "queued" || task.status === "running",
  );
}

function resolveTaskTerminalReferenceAt(task: TaskRecord): number {
  return task.endedAt ?? task.lastEventAt ?? task.createdAt;
}

function pickLatestTask(tasks: TaskRecord[]): TaskRecord | undefined {
  return [...tasks].sort(
    (left, right) => resolveTaskTerminalReferenceAt(right) - resolveTaskTerminalReferenceAt(left),
  )[0];
}

function resolveManagedFlowTerminalFromLinkedTasks(
  flow: TaskFlowRecord,
):
  | {
      status: TaskFlowStatus;
      blockedTaskId: string | null;
      blockedSummary: string | null;
      updatedAt: number;
      endedAt: number;
    }
  | undefined {
  if (flow.syncMode !== "managed" || isTerminalFlow(flow)) {
    return undefined;
  }
  const linkedTasks = listTasksForFlowId(flow.flowId);
  if (linkedTasks.length === 0) {
    return undefined;
  }
  if (linkedTasks.some((task) => task.status === "queued" || task.status === "running")) {
    return undefined;
  }

  const latestEventAt = Math.max(flow.updatedAt, ...linkedTasks.map((task) => resolveTaskTerminalReferenceAt(task)));

  const lostTask = pickLatestTask(linkedTasks.filter((task) => task.status === "lost"));
  if (lostTask) {
    return {
      status: "lost",
      blockedTaskId: null,
      blockedSummary: lostTask.error ?? lostTask.terminalSummary ?? lostTask.progressSummary ?? null,
      updatedAt: latestEventAt,
      endedAt: latestEventAt,
    };
  }

  const failedTask = pickLatestTask(
    linkedTasks.filter((task) => task.status === "failed" || task.status === "timed_out"),
  );
  if (failedTask) {
    return {
      status: "failed",
      blockedTaskId: null,
      blockedSummary:
        failedTask.error ?? failedTask.terminalSummary ?? failedTask.progressSummary ?? null,
      updatedAt: latestEventAt,
      endedAt: latestEventAt,
    };
  }

  const blockedTask = pickLatestTask(
    linkedTasks.filter(
      (task) =>
        task.status === "succeeded" && deriveTaskFlowStatusFromTask(task) === "blocked",
    ),
  );
  if (blockedTask) {
    return {
      status: "blocked",
      blockedTaskId: blockedTask.taskId,
      blockedSummary: blockedTask.terminalSummary ?? blockedTask.progressSummary ?? null,
      updatedAt: latestEventAt,
      endedAt: latestEventAt,
    };
  }

  const cancelledTask = pickLatestTask(linkedTasks.filter((task) => task.status === "cancelled"));
  if (cancelledTask) {
    return {
      status: "cancelled",
      blockedTaskId: null,
      blockedSummary: null,
      updatedAt: latestEventAt,
      endedAt: latestEventAt,
    };
  }

  if (linkedTasks.every((task) => task.status === "succeeded")) {
    return {
      status: "succeeded",
      blockedTaskId: null,
      blockedSummary: null,
      updatedAt: latestEventAt,
      endedAt: latestEventAt,
    };
  }

  return undefined;
}

function reconcileManagedFlowTerminalFromLinkedTasks(flow: TaskFlowRecord): boolean {
  let current = flow;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const projection = resolveManagedFlowTerminalFromLinkedTasks(current);
    if (!projection) {
      return false;
    }
    const result = updateFlowRecordByIdExpectedRevision({
      flowId: current.flowId,
      expectedRevision: current.revision,
      patch: {
        status: projection.status,
        blockedTaskId: projection.blockedTaskId,
        blockedSummary: projection.blockedSummary,
        waitJson: null,
        endedAt: projection.endedAt,
        updatedAt: projection.updatedAt,
      },
    });
    if (result.applied) {
      return true;
    }
    if (result.reason === "not_found" || !result.current) {
      return false;
    }
    current = result.current;
  }
  return false;
}

function resolveTerminalAt(flow: TaskFlowRecord): number {
  return flow.endedAt ?? flow.updatedAt ?? flow.createdAt;
}

function shouldPruneFlow(flow: TaskFlowRecord, now: number): boolean {
  if (!isTerminalFlow(flow)) {
    return false;
  }
  if (hasActiveLinkedTasks(flow.flowId)) {
    return false;
  }
  return now - resolveTerminalAt(flow) >= TASK_FLOW_RETENTION_MS;
}

function shouldFinalizeCancelledFlow(flow: TaskFlowRecord): boolean {
  if (flow.syncMode !== "managed") {
    return false;
  }
  if (flow.cancelRequestedAt == null || isTerminalFlow(flow)) {
    return false;
  }
  return !hasActiveLinkedTasks(flow.flowId);
}

function finalizeCancelledFlow(flow: TaskFlowRecord, now: number): boolean {
  let current = flow;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const endedAt = Math.max(now, current.updatedAt, current.cancelRequestedAt ?? now);
    const result = updateFlowRecordByIdExpectedRevision({
      flowId: current.flowId,
      expectedRevision: current.revision,
      patch: {
        status: "cancelled",
        blockedTaskId: null,
        blockedSummary: null,
        waitJson: null,
        endedAt,
        updatedAt: endedAt,
      },
    });
    if (result.applied) {
      return true;
    }
    if (result.reason === "not_found" || !result.current) {
      return false;
    }
    current = result.current;
    if (!shouldFinalizeCancelledFlow(current)) {
      return false;
    }
  }
  return false;
}

export function getInspectableTaskFlowAuditSummary(): TaskFlowAuditSummary {
  return summarizeTaskFlowAuditFindings(listTaskFlowAuditFindings());
}

export function previewTaskFlowRegistryMaintenance(): TaskFlowRegistryMaintenanceSummary {
  const now = Date.now();
  let reconciled = 0;
  let pruned = 0;
  for (const flow of listTaskFlowRecords()) {
    if (resolveManagedFlowTerminalFromLinkedTasks(flow)) {
      reconciled += 1;
      continue;
    }
    if (shouldFinalizeCancelledFlow(flow)) {
      reconciled += 1;
      continue;
    }
    if (shouldPruneFlow(flow, now)) {
      pruned += 1;
    }
  }
  return { reconciled, pruned };
}

export async function runTaskFlowRegistryMaintenance(): Promise<TaskFlowRegistryMaintenanceSummary> {
  const now = Date.now();
  let reconciled = 0;
  let pruned = 0;
  for (const flow of listTaskFlowRecords()) {
    const current = getTaskFlowById(flow.flowId);
    if (!current) {
      continue;
    }
    if (reconcileManagedFlowTerminalFromLinkedTasks(current)) {
      reconciled += 1;
      continue;
    }
    if (shouldFinalizeCancelledFlow(current)) {
      if (finalizeCancelledFlow(current, now)) {
        reconciled += 1;
      }
      continue;
    }
    if (shouldPruneFlow(current, now) && deleteTaskFlowRecordById(current.flowId)) {
      pruned += 1;
    }
  }
  return { reconciled, pruned };
}
