import type { RunTaskInFlowResult } from "../../tasks/task-flow-managed-run-task.types.js";
import type { TaskFlowRegistryUpdateResult } from "../../tasks/task-flow-registry.store.types.js";
import type { TaskFlowRecord } from "../../tasks/task-flow-registry.types.js";
import type { TaskFlowUpdateResult } from "../../tasks/task-flow-runtime-internal.js";
import type {
  BoundTaskFlowRuntime,
  ManagedTaskFlowMutationResult,
  ManagedTaskFlowRecord,
} from "./runtime-taskflow.types.js";

function isManagedFlow(flow: TaskFlowRecord | undefined): flow is ManagedTaskFlowRecord {
  return flow?.syncMode === "managed" && Boolean(flow.controllerId);
}

export function asManagedTaskFlowRecord(
  flow: TaskFlowRecord | undefined,
): ManagedTaskFlowRecord | undefined {
  return isManagedFlow(flow) ? flow : undefined;
}

export function mapFlowUpdateResult(
  result:
    | TaskFlowUpdateResult
    | TaskFlowRegistryUpdateResult
    | {
        applied: false;
        reason: "not_managed";
        current: TaskFlowRecord;
      },
): ManagedTaskFlowMutationResult {
  if (result.applied) {
    const managed = asManagedTaskFlowRecord(result.flow);
    return managed
      ? { applied: true, flow: managed }
      : { applied: false, code: "not_managed", current: result.flow };
  }
  if (result.reason === "invalid_patch") {
    throw result.error;
  }
  return {
    applied: false,
    code: result.reason,
    ...("current" in result && result.current ? { current: result.current } : {}),
  };
}

export function mapFlowTaskRunResult(
  created: RunTaskInFlowResult,
): ReturnType<BoundTaskFlowRuntime["runTask"]> {
  if (!created.created) {
    return {
      created: false,
      found: created.found,
      reason: created.reason ?? "Task was not created.",
      ...(created.flow ? { flow: created.flow } : {}),
    };
  }
  const managed = asManagedTaskFlowRecord(created.flow);
  if (!managed) {
    return {
      created: false,
      found: true,
      reason: "TaskFlow does not accept managed child tasks.",
      flow: created.flow,
    };
  }
  if (!created.task) {
    return {
      created: false,
      found: true,
      reason: "Task was not created.",
      flow: created.flow,
    };
  }
  return {
    created: true,
    flow: managed,
    task: created.task,
  };
}
