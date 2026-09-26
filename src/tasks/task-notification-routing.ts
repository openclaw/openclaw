import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { shouldRouteCompletionThroughRequesterSession } from "../auto-reply/reply/completion-delivery-policy.js";
import { channelSupportsThreadDelivery } from "../channels/thread-addressing.js";
import { requestHeartbeat } from "../infra/heartbeat-wake.js";
import { withSystemEventOwner } from "../infra/system-event-ownership.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import { isDeliverableMessageChannel } from "../utils/message-channel.js";
import { readTaskBackingInstance } from "./task-backing-records.js";
import {
  formatTaskBlockedFollowupMessage,
  shouldUseParentReviewTaskTerminalMessage,
} from "./task-executor-policy.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import { getTaskFlowById } from "./task-flow-runtime-internal.js";
import { getTasksByRunId, taskDeliveryStates } from "./task-registry-state.js";
import type { TaskDeliveryState, TaskEventRecord, TaskRecord } from "./task-registry.types.js";
import { resolveTaskSessionAgentId } from "./task-session-identity.js";

export type TaskDeliveryOwner = {
  sessionKey?: string;
  agentId?: string;
  requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  flowId?: string;
};

export function getPeerTasksForDelivery(task: TaskRecord): TaskRecord[] {
  if (!task.runId?.trim()) {
    return [];
  }
  const backing = task.runtime === "acp" ? readTaskBackingInstance(task.detail) : undefined;
  const instanceId = backing?.runtime === "acp" ? backing.instanceId : undefined;
  return getTasksByRunId(task.runId).filter((candidate) => {
    const candidateBacking =
      task.runtime === "acp" ? readTaskBackingInstance(candidate.detail) : undefined;
    return (
      candidate.runtime === task.runtime &&
      candidate.scopeKind === task.scopeKind &&
      (normalizeOptionalString(candidate.ownerKey) ?? "") ===
        (normalizeOptionalString(task.ownerKey) ?? "") &&
      (normalizeOptionalString(candidate.childSessionKey) ?? "") ===
        (normalizeOptionalString(task.childSessionKey) ?? "") &&
      (candidateBacking?.runtime === "acp" ? candidateBacking.instanceId : undefined) === instanceId
    );
  });
}

export function resolveTaskDeliveryOwner(
  task: TaskRecord,
  readFlow: (flowId: string) => Readonly<TaskFlowRecord> | undefined = getTaskFlowById,
): TaskDeliveryOwner {
  if (task.scopeKind !== "session") {
    return {};
  }
  const flowId = task.parentFlowId?.trim();
  const candidate = flowId ? readFlow(flowId) : undefined;
  const flow =
    candidate &&
    normalizeOptionalString(candidate.ownerKey) === normalizeOptionalString(task.ownerKey)
      ? candidate
      : undefined;
  return {
    sessionKey: task.ownerKey.trim(),
    // Bare session keys are shared across agents; the executor is not the requester.
    agentId: resolveTaskSessionAgentId(task.ownerKey, task.requesterAgentId),
    requesterOrigin: normalizeDeliveryContext(
      flow?.requesterOrigin ?? taskDeliveryStates.get(task.taskId)?.requesterOrigin,
    ),
    ...(flow ? { flowId: flow.flowId } : {}),
  };
}

export function canDeliverTaskToRequesterOrigin(owner: TaskDeliveryOwner): boolean {
  if (shouldRouteCompletionThroughRequesterSession(owner.sessionKey)) {
    return false;
  }
  return canDeliverToRequesterOrigin(owner.requesterOrigin);
}

export function canDeliverToRequesterOrigin(origin: TaskDeliveryState["requesterOrigin"]): boolean {
  const channel = origin?.channel?.trim();
  const to = origin?.to?.trim();
  return Boolean(channel && to && isDeliverableMessageChannel(channel));
}

export function canDeliverParentReviewTaskToThreadOrigin(
  task: TaskRecord,
  owner: TaskDeliveryOwner,
): boolean {
  if (!shouldUseParentReviewTaskTerminalMessage(task)) {
    return false;
  }
  const origin = owner.requesterOrigin;
  const threadId = String(origin?.threadId ?? "").trim();
  // Parent-review terminal messages may deliver directly only when the requester origin
  // already names a concrete thread on a transport that declares thread-addressed
  // delivery; root-level origins keep routing through the parent session.
  // Deliberately no target-shape parsing here: threadId provenance is the channel's own
  // route/binding projection, so core trusts the tuple. A stray threadId on a non-thread
  // target degrades to delivery at that origin's root, and send failures fall back to the
  // parent-session queue below — the handoff cannot be lost.
  return Boolean(
    threadId &&
    channelSupportsThreadDelivery(origin?.channel) &&
    canDeliverToRequesterOrigin(origin),
  );
}

export function queueTaskSystemEvent(
  task: TaskRecord,
  text: string,
  owner: TaskDeliveryOwner,
  source: "background-task" | "background-task-blocked" = "background-task",
) {
  const ownerKey = owner.sessionKey?.trim();
  if (!ownerKey) {
    return false;
  }
  const options = {
    sessionKey: ownerKey,
    contextKey: `task:${task.taskId}${source === "background-task-blocked" ? ":blocked-followup" : ""}`,
    deliveryContext: owner.requesterOrigin,
  };
  enqueueSystemEvent(text, owner.agentId ? withSystemEventOwner(options, owner.agentId) : options);
  requestHeartbeat({
    source,
    intent: "immediate",
    reason: source,
    sessionKey: ownerKey,
    agentId: owner.agentId,
  });
  return true;
}

export function queueBlockedTaskFollowup(task: TaskRecord, owner: TaskDeliveryOwner) {
  const followupText = formatTaskBlockedFollowupMessage(task);
  if (!followupText) {
    return false;
  }
  return queueTaskSystemEvent(task, followupText, owner, "background-task-blocked");
}

export function resolveTaskStateChangeIdempotencyKey(params: {
  task: TaskRecord;
  latestEvent: TaskEventRecord;
  owner: TaskDeliveryOwner;
}): string {
  if (params.owner.flowId) {
    return `flow-event:${params.owner.flowId}:${params.task.taskId}:${params.latestEvent.at}:${params.latestEvent.kind}`;
  }
  return `task-event:${params.task.taskId}:${params.latestEvent.at}:${params.latestEvent.kind}`;
}

export function resolveTaskTerminalIdempotencyKey(
  task: TaskRecord,
  owner: TaskDeliveryOwner,
): string {
  const prefix = owner.flowId ? `flow-terminal:${owner.flowId}` : "task-terminal";
  const outcome = task.status === "succeeded" ? (task.terminalOutcome ?? "default") : "default";
  return `${prefix}:${task.taskId}:${task.status}:${outcome}`;
}
