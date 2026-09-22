import type { DatabaseSync } from "node:sqlite";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { deferSqlitePostCommitPublication } from "../infra/sqlite-post-commit.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import {
  createManagedTaskBackingDetail,
  selectCurrentCanonicalTaskBacking,
} from "./task-backing-records.js";
import type {
  RunTaskInFlowParams,
  RunTaskInFlowResult,
} from "./task-flow-managed-run-task.types.js";
import { normalizeRestoredFlowRecord } from "./task-flow-registry.records.js";
import { readTaskFlowRecord } from "./task-flow-registry.store.kernel.js";
import { isTerminalTaskFlow, type TaskFlowRecord } from "./task-flow-registry.types.js";
import { assertTaskOwner } from "./task-registry-common.js";
import {
  buildTaskCreateMergePatch,
  selectExistingTaskForCreate,
} from "./task-registry-create-rules.js";
import {
  applyTaskRecordPatch,
  buildTaskRecordForCreate,
  resolveTaskCreateIdentity,
  type CreateTaskRecordParams,
} from "./task-registry-records.js";
import {
  readTaskRegistryMutationSnapshotInDatabase,
  upsertTaskDeliveryStateInDatabase,
  upsertTaskWithDeliveryStateInDatabase,
} from "./task-registry.store.kernel.js";
import { isTerminalTaskStatus } from "./task-registry.types.js";

export type ManagedTaskInFlowInput = {
  callerOwnerKey: string;
  params: RunTaskInFlowParams;
  taskId: string;
  now: number;
};

/** The caller holds shared writer custody; write retains the owner's separate transactions. */
export function runManagedTaskInFlowInDatabase(
  db: DatabaseSync,
  input: ManagedTaskInFlowInput,
  write: <T>(operation: () => T) => T,
  onCommitted: (result: RunTaskInFlowResult) => void,
): RunTaskInFlowResult {
  const { params } = input;
  const storedFlow = readTaskFlowRecord(db, params.flowId);
  const finish = (result: RunTaskInFlowResult) => {
    onCommitted(result);
    return result;
  };
  if (
    !storedFlow ||
    normalizeOptionalString(storedFlow.ownerKey) !== normalizeOptionalString(input.callerOwnerKey)
  ) {
    return finish({ found: false, created: false, reason: "Flow not found." });
  }
  const flow = normalizeRestoredFlowRecord(storedFlow);
  const refuse = (reason: string) => finish({ found: true, created: false, reason, flow });
  if (flow.syncMode !== "managed") {
    return refuse("Flow does not accept managed child tasks.");
  }
  if (flow.cancelRequestedAt != null) {
    return refuse("Flow cancellation has already been requested.");
  }
  if (isTerminalTaskFlow(flow)) {
    return refuse(`Flow is already ${flow.status}.`);
  }

  const snapshot = readTaskRegistryMutationSnapshotInDatabase(db, {
    ...params,
    taskId: input.taskId,
  });
  const candidates = [...snapshot.tasks.values()];
  const flows = new Map<string, TaskFlowRecord | undefined>([[flow.flowId, flow]]);
  const isTaskMirroredFlow = (flowId: string) => {
    if (!flows.has(flowId)) {
      flows.set(flowId, readTaskFlowRecord(db, flowId));
    }
    return flows.get(flowId)?.syncMode === "task_mirrored";
  };
  const childSessionKey = params.childSessionKey?.trim();
  const runId = params.runId?.trim();
  const backing =
    childSessionKey && runId && (params.runtime === "acp" || params.runtime === "subagent")
      ? selectCurrentCanonicalTaskBacking({
          runtime: params.runtime,
          scopeKind: "session",
          ownerKey: flow.ownerKey,
          childSessionKey,
          runId,
          candidates,
          isTaskMirroredFlow,
        })
      : undefined;
  if (childSessionKey && (params.runtime === "acp" || params.runtime === "subagent") && !backing) {
    return refuse("Task backing ownership could not be verified.");
  }
  const createParams: CreateTaskRecordParams = {
    runtime: params.runtime,
    sourceId: params.sourceId,
    ownerKey: flow.ownerKey,
    scopeKind: "session",
    requesterOrigin: flow.requesterOrigin,
    parentFlowId: flow.flowId,
    childSessionKey: params.childSessionKey,
    parentTaskId: params.parentTaskId,
    agentId: params.agentId,
    runId: params.runId,
    label: params.label,
    task: params.task,
    preferMetadata: params.preferMetadata,
    notifyPolicy: params.notifyPolicy,
    deliveryStatus: params.deliveryStatus ?? "pending",
    detail: createManagedTaskBackingDetail(backing),
    status: params.status === "running" ? "running" : "queued",
    ...(params.status === "running"
      ? {
          startedAt: params.startedAt,
          lastEventAt: params.lastEventAt,
          progressSummary: params.progressSummary,
        }
      : {}),
  };
  const identity = resolveTaskCreateIdentity(createParams);
  assertTaskOwner(identity);
  const existing = selectExistingTaskForCreate({
    ...params,
    ownerKey: identity.ownerKey,
    scopeKind: identity.scopeKind,
    parentFlowId: flow.flowId,
    detail: createParams.detail,
    candidates,
    isTaskMirroredFlow,
  });
  // Terminal projections may still accept metadata; they cannot restart the backing run.
  if (
    backing &&
    isTerminalTaskStatus(backing.task.status) &&
    (!existing || !isTerminalTaskStatus(existing.status))
  ) {
    return refuse("Task backing ownership could not be verified.");
  }
  let task;
  let deliveryState;
  if (existing) {
    deliveryState = snapshot.deliveryStates.get(existing.taskId);
    const requesterOrigin = normalizeDeliveryContext(createParams.requesterOrigin);
    if (requesterOrigin && !deliveryState?.requesterOrigin) {
      const nextDeliveryState = {
        taskId: existing.taskId,
        requesterOrigin,
        lastNotifiedEventAt: deliveryState?.lastNotifiedEventAt,
      };
      // Preserve the origin-only commit before an optional task metadata update.
      write(() => upsertTaskDeliveryStateInDatabase(db, nextDeliveryState));
      deliveryState = nextDeliveryState;
    }
    const patch = buildTaskCreateMergePatch(existing, {
      ...createParams,
      agentId: identity.agentId,
    });
    if (Object.keys(patch).length === 0) {
      return finish({ found: true, created: true, flow, task: existing });
    }
    task = applyTaskRecordPatch(existing, patch, input.now);
  } else {
    const prepared = buildTaskRecordForCreate(createParams, identity, input);
    task = prepared.record;
    deliveryState = prepared.deliveryState;
  }
  const result: RunTaskInFlowResult = { found: true, created: true, flow, task };
  write(() => {
    upsertTaskWithDeliveryStateInDatabase({ db }, { task, deliveryState });
    deferSqlitePostCommitPublication(db, () => onCommitted(result));
  });
  return result;
}
