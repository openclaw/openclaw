import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isTerminalTaskFlow, type TaskFlowRecord } from "./task-flow-registry.types.js";
import { ensureTaskFlowRegistryReady, getTaskFlowById } from "./task-flow-runtime-internal.js";
import type { TaskRecord, TaskScopeKind } from "./task-registry.types.js";

type ParentFlowLinkErrorCode =
  | "scope_kind_not_session"
  | "parent_flow_not_found"
  | "owner_key_mismatch"
  | "cancel_requested"
  | "terminal";

class ParentFlowLinkError extends Error {
  constructor(
    public readonly code: ParentFlowLinkErrorCode,
    message: string,
    public readonly details?: {
      flowId?: string;
      status?: TaskFlowRecord["status"];
    },
  ) {
    super(message);
    this.name = "ParentFlowLinkError";
  }
}

export function isParentFlowLinkError(error: unknown): error is ParentFlowLinkError {
  return error instanceof ParentFlowLinkError;
}

export function assertParentFlowLinkAllowed(params: {
  ownerKey: string;
  scopeKind: TaskScopeKind;
  parentFlowId?: string;
}) {
  const flowId = params.parentFlowId?.trim();
  if (!flowId) {
    return;
  }
  if (params.scopeKind !== "session") {
    throw new ParentFlowLinkError(
      "scope_kind_not_session",
      "Only session-scoped tasks can link to flows.",
      { flowId },
    );
  }
  const flow = getTaskFlowById(flowId);
  if (!flow) {
    throw new ParentFlowLinkError("parent_flow_not_found", `Parent flow not found: ${flowId}`, {
      flowId,
    });
  }
  if (normalizeOptionalString(flow.ownerKey) !== normalizeOptionalString(params.ownerKey)) {
    throw new ParentFlowLinkError(
      "owner_key_mismatch",
      "Task ownerKey must match parent flow ownerKey.",
      { flowId },
    );
  }
  if (flow.cancelRequestedAt != null) {
    throw new ParentFlowLinkError(
      "cancel_requested",
      "Parent flow cancellation has already been requested.",
      { flowId, status: flow.status },
    );
  }
  if (isTerminalTaskFlow(flow)) {
    throw new ParentFlowLinkError("terminal", `Parent flow is already ${flow.status}.`, {
      flowId,
      status: flow.status,
    });
  }
}

export function ensureLinkedTaskFlowRegistryReady(task: Pick<TaskRecord, "parentFlowId">): void {
  if (task.parentFlowId?.trim()) {
    ensureTaskFlowRegistryReady();
  }
}
