import type { DatabaseSync } from "node:sqlite";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  createManagedTaskBackingDetail,
  sameTaskBackingInstance,
  selectCurrentCanonicalTaskBacking,
} from "./task-backing-records.js";
import type {
  RunTaskInFlowParams,
  RunTaskInFlowResult,
} from "./task-flow-managed-run-task.types.js";
import { normalizeRestoredFlowRecord } from "./task-flow-registry.records.js";
import { readTaskFlowRecord } from "./task-flow-registry.store.kernel.js";
import { isTerminalTaskFlow } from "./task-flow-registry.types.js";
import {
  createTaskRecordInDatabase,
  type TaskCreateResult,
} from "./task-registry-create.kernel.js";
import { isParentFlowLinkError } from "./task-registry-parent-flow-rules.js";
import type { CreateTaskRecordParams } from "./task-registry-records.js";
import { readTaskRegistryMutationSnapshotInDatabase } from "./task-registry.store.kernel.js";
import { isTerminalTaskStatus } from "./task-registry.types.js";

export type ManagedTaskInFlowInput = {
  callerOwnerKey: string;
  params: RunTaskInFlowParams;
  taskId: string;
  now: number;
};

export type ManagedTaskInFlowReceipt = RunTaskInFlowResult & {
  taskMutation?: TaskCreateResult["mutation"];
};

class ManagedTaskCreationRefused extends Error {
  constructor(readonly result: RunTaskInFlowResult) {
    super(result.reason);
  }
}

/** The caller holds shared writer custody; write retains the owner's separate transactions. */
export function runManagedTaskInFlowInDatabase(
  db: DatabaseSync,
  input: ManagedTaskInFlowInput,
  write: <T>(operation: () => T) => T,
  onCommitted: (result: ManagedTaskInFlowReceipt) => void,
  admission?: { assertCurrent: () => void; retainTaskCommit: (taskId: string) => void },
): ManagedTaskInFlowReceipt {
  const { params } = input;
  const readManagedFlow = () => {
    const storedFlow = readTaskFlowRecord(db, params.flowId);
    if (
      !storedFlow ||
      normalizeOptionalString(storedFlow.ownerKey) !== normalizeOptionalString(input.callerOwnerKey)
    ) {
      throw new ManagedTaskCreationRefused({
        found: false,
        created: false,
        reason: "Flow not found.",
      });
    }
    const flow = normalizeRestoredFlowRecord(storedFlow);
    const reason =
      flow.syncMode !== "managed"
        ? "Flow does not accept managed child tasks."
        : flow.cancelRequestedAt != null
          ? "Flow cancellation has already been requested."
          : isTerminalTaskFlow(flow)
            ? `Flow is already ${flow.status}.`
            : undefined;
    if (reason) {
      throw new ManagedTaskCreationRefused({ found: true, created: false, reason, flow });
    }
    return flow;
  };
  try {
    const flow = readManagedFlow();
    const childSessionKey = params.childSessionKey?.trim();
    const runId = params.runId?.trim();
    const readBacking = () => {
      const snapshot = readTaskRegistryMutationSnapshotInDatabase(db, {
        ...params,
        taskId: input.taskId,
      });
      const backing =
        childSessionKey && runId && (params.runtime === "acp" || params.runtime === "subagent")
          ? selectCurrentCanonicalTaskBacking({
              runtime: params.runtime,
              scopeKind: "session",
              ownerKey: flow.ownerKey,
              childSessionKey,
              runId,
              candidates: [...snapshot.tasks.values()],
              isTaskMirroredFlow: (flowId) =>
                readTaskFlowRecord(db, flowId)?.syncMode === "task_mirrored",
            })
          : undefined;
      if (
        childSessionKey &&
        (params.runtime === "acp" || params.runtime === "subagent") &&
        !backing
      ) {
        throw new ManagedTaskCreationRefused({
          found: true,
          created: false,
          reason: "Task backing ownership could not be verified.",
          flow,
        });
      }
      return backing;
    };
    const backing = readBacking();
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
    const resultForTask = (receipt: TaskCreateResult): ManagedTaskInFlowReceipt => ({
      found: true,
      created: true,
      flow,
      task: receipt.task,
      taskMutation: receipt.mutation,
    });
    const created = createTaskRecordInDatabase(db, { ...input, params: createParams }, write, {
      retainTaskCommit: admission?.retainTaskCommit,
      assertCurrent: (existing) => {
        readManagedFlow();
        const currentBacking = readBacking();
        if (
          backing &&
          (!currentBacking ||
            currentBacking.task.taskId !== backing.task.taskId ||
            !sameTaskBackingInstance(currentBacking.instance, backing.instance) ||
            // Terminal projections accept metadata, but cannot restart their backing run.
            (isTerminalTaskStatus(currentBacking.task.status) &&
              (!existing || !isTerminalTaskStatus(existing.status))))
        ) {
          throw new ManagedTaskCreationRefused({
            found: true,
            created: false,
            reason: "Task backing ownership could not be verified.",
            flow,
          });
        }
        admission?.assertCurrent();
      },
      onCommitted: (commit) => {
        if (commit.kind === "task") {
          onCommitted(resultForTask(commit.result));
        }
      },
    });
    return resultForTask(created);
  } catch (error) {
    if (isParentFlowLinkError(error)) {
      // Translate fresh parent refusal through the managed API's existing result contract.
      try {
        readManagedFlow();
      } catch (flowError) {
        if (flowError instanceof ManagedTaskCreationRefused) {
          onCommitted(flowError.result);
          return flowError.result;
        }
        throw flowError;
      }
    }
    if (error instanceof ManagedTaskCreationRefused) {
      onCommitted(error.result);
      return error.result;
    }
    throw error;
  }
}
