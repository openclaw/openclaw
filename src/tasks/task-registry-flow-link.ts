import { ensureTaskFlowRegistryReady, getTaskFlowById } from "./task-flow-runtime-internal.js";
import { assertParentFlowRecordLinkAllowed } from "./task-registry-parent-flow-rules.js";
import type { TaskRecord, TaskScopeKind } from "./task-registry.types.js";

export { isParentFlowLinkError } from "./task-registry-parent-flow-rules.js";

export function assertParentFlowLinkAllowed(params: {
  ownerKey: string;
  scopeKind: TaskScopeKind;
  parentFlowId?: string;
}) {
  const flowId = params.parentFlowId?.trim();
  assertParentFlowRecordLinkAllowed(
    params,
    flowId && params.scopeKind === "session" ? getTaskFlowById(flowId) : undefined,
  );
}

export function ensureLinkedTaskFlowRegistryReady(task: Pick<TaskRecord, "parentFlowId">): void {
  if (task.parentFlowId?.trim()) {
    ensureTaskFlowRegistryReady();
  }
}
