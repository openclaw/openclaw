import type { JsonValue, TaskFlowStatus } from "../tasks/task-flow-registry.types.js";
import {
  getTaskFlowById,
  updateFlowRecordByIdExpectedRevision,
} from "../tasks/task-flow-runtime-internal.js";
import {
  buildDurableCoordinationProjection,
  buildDurableTaskFlowStateProjection,
  mergeDurableProjectionIntoJsonObject,
  type DurableCoordinationProjection,
} from "./coordination-projection.js";
import type { DurableRuntimeStore } from "./types.js";

export type DurableTaskFlowSyncResult =
  | {
      synced: true;
      flowId: string;
      runtimeRunId: string;
      status: TaskFlowStatus;
    }
  | {
      synced: false;
      reason:
        | "run_not_found"
        | "flow_not_bound"
        | "flow_not_found"
        | "revision_conflict"
        | "persist_failed";
      runtimeRunId: string;
      flowId?: string;
    };

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (value && typeof value === "object") {
    return Object.values(value).every(isJsonValue);
  }
  return false;
}

function toJsonValue(value: Record<string, unknown>): JsonValue {
  return isJsonValue(value) ? value : {};
}

function mapProjectionToFlowStatus(projection: DurableCoordinationProjection): TaskFlowStatus {
  switch (projection.status) {
    case "accepted":
    case "received":
    case "queued":
      return "queued";
    case "running":
    case "retrying":
      return "running";
    case "waiting":
    case "waiting_signal":
    case "waiting_timer":
    case "waiting_child":
    case "blocked":
    case "retry_scheduled":
    case "canceling":
    case "unknown_after_side_effect":
      return "waiting";
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "lost":
      return "lost";
  }
}

function buildWaitJson(projection: DurableCoordinationProjection): JsonValue | null {
  if (!projection.waitingReason) {
    return null;
  }
  return {
    durable: {
      waitingReason: projection.waitingReason,
      runtimeRunId: projection.runtimeRunId,
      ...(projection.currentStepId ? { stepId: projection.currentStepId } : {}),
      updatedAt: projection.updatedAt,
    },
  };
}

export function buildDurableTaskFlowPatch(projection: DurableCoordinationProjection): {
  status: TaskFlowStatus;
  currentStep?: string | null;
  stateJson: JsonValue;
  waitJson: JsonValue | null;
  endedAt?: number | null;
  updatedAt: number;
} {
  const status = mapProjectionToFlowStatus(projection);
  const durableState = buildDurableTaskFlowStateProjection(projection);
  return {
    status,
    currentStep: projection.currentStepId ?? null,
    stateJson: toJsonValue(mergeDurableProjectionIntoJsonObject(undefined, durableState)),
    waitJson: status === "waiting" ? buildWaitJson(projection) : null,
    endedAt:
      status === "succeeded" || status === "failed" || status === "cancelled" || status === "lost"
        ? (projection.completedAt ?? projection.updatedAt)
        : null,
    updatedAt: projection.updatedAt,
  };
}

function tryUpdateTaskFlow(params: {
  flowId: string;
  projection: DurableCoordinationProjection;
}): DurableTaskFlowSyncResult {
  const flow = getTaskFlowById(params.flowId);
  if (!flow) {
    return {
      synced: false,
      reason: "flow_not_found",
      runtimeRunId: params.projection.runtimeRunId,
      flowId: params.flowId,
    };
  }
  const patch = buildDurableTaskFlowPatch(params.projection);
  const result = updateFlowRecordByIdExpectedRevision({
    flowId: flow.flowId,
    expectedRevision: flow.revision,
    patch,
  });
  if (result.applied) {
    return {
      synced: true,
      flowId: result.flow.flowId,
      runtimeRunId: params.projection.runtimeRunId,
      status: result.flow.status,
    };
  }
  return {
    synced: false,
    reason: result.reason === "not_found" ? "flow_not_found" : result.reason,
    runtimeRunId: params.projection.runtimeRunId,
    flowId: params.flowId,
  };
}

export function syncDurableRunToTaskFlow(params: {
  store: DurableRuntimeStore;
  runtimeRunId: string;
}): DurableTaskFlowSyncResult {
  const run = params.store.getRun(params.runtimeRunId);
  if (!run) {
    return { synced: false, reason: "run_not_found", runtimeRunId: params.runtimeRunId };
  }
  const projection = buildDurableCoordinationProjection({
    run,
    steps: params.store.listSteps(run.runtimeRunId),
    childLinks: params.store.listChildLinks(run.runtimeRunId),
    refs: params.store.listRefs(run.runtimeRunId),
  });
  const flowId = projection.external.taskFlowId;
  if (!flowId) {
    return { synced: false, reason: "flow_not_bound", runtimeRunId: run.runtimeRunId };
  }
  const first = tryUpdateTaskFlow({ flowId, projection });
  if (first.synced || first.reason !== "revision_conflict") {
    return first;
  }
  return tryUpdateTaskFlow({ flowId, projection });
}

export function syncDurableRunToTaskFlowBestEffort(params: {
  store: DurableRuntimeStore;
  runtimeRunId: string;
}): void {
  try {
    syncDurableRunToTaskFlow(params);
  } catch {
    // Projection writes must never break live durable recovery or agent runtime paths.
  }
}
