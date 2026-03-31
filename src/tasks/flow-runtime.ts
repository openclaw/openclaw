import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { isDeliverableMessageChannel } from "../utils/message-channel.js";
import { createFlowRecord, getFlowById, updateFlowRecordById } from "./flow-registry.js";
import type { FlowOutputBag, FlowOutputValue, FlowRecord } from "./flow-registry.types.js";
import { createQueuedTaskRun, createRunningTaskRun } from "./task-executor.js";
import { listTasksForFlowId } from "./task-registry.js";
import type {
  TaskDeliveryStatus,
  TaskNotifyPolicy,
  TaskRecord,
  TaskRuntime,
} from "./task-registry.types.js";

let deliveryRuntimePromise: Promise<typeof import("./task-registry-delivery-runtime.js")> | null =
  null;

type FlowTaskLaunch = "queued" | "running";

export type FlowUpdateDelivery = "direct" | "session_queued" | "parent_missing" | "failed";

function loadFlowDeliveryRuntime() {
  deliveryRuntimePromise ??= import("./task-registry-delivery-runtime.js");
  return deliveryRuntimePromise;
}

function requireFlow(flowId: string): FlowRecord {
  const flow = getFlowById(flowId);
  if (!flow) {
    throw new Error(`Flow not found: ${flowId}`);
  }
  return flow;
}

function requireLinearFlow(flowId: string): FlowRecord {
  const flow = requireFlow(flowId);
  if (flow.shape !== "linear") {
    throw new Error(`Flow is not linear: ${flowId}`);
  }
  return flow;
}

function cloneOutputValue<T extends FlowOutputValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function updateRequiredFlow(
  flowId: string,
  patch: Parameters<typeof updateFlowRecordById>[1],
): FlowRecord {
  const updated = updateFlowRecordById(flowId, patch);
  if (!updated) {
    throw new Error(`Flow not found: ${flowId}`);
  }
  return updated;
}

function resolveFlowOutputs(flow: FlowRecord): FlowOutputBag {
  return flow.outputs ? cloneOutputValue(flow.outputs) : {};
}

function canDeliverFlowToRequesterOrigin(flow: FlowRecord): boolean {
  const channel = flow.requesterOrigin?.channel?.trim();
  const to = flow.requesterOrigin?.to?.trim();
  return Boolean(channel && to && isDeliverableMessageChannel(channel));
}

export function createFlow(params: {
  ownerSessionKey: string;
  requesterOrigin?: FlowRecord["requesterOrigin"];
  goal: string;
  notifyPolicy?: TaskNotifyPolicy;
  currentStep?: string;
  createdAt?: number;
  updatedAt?: number;
}): FlowRecord {
  return createFlowRecord({
    shape: "linear",
    ownerSessionKey: params.ownerSessionKey,
    requesterOrigin: params.requesterOrigin,
    goal: params.goal,
    notifyPolicy: params.notifyPolicy,
    currentStep: params.currentStep,
    status: "queued",
    createdAt: params.createdAt,
    updatedAt: params.updatedAt,
  });
}

export function runTaskInFlow(params: {
  flowId: string;
  runtime: TaskRuntime;
  sourceId?: string;
  childSessionKey?: string;
  parentTaskId?: string;
  agentId?: string;
  runId?: string;
  label?: string;
  task: string;
  preferMetadata?: boolean;
  notifyPolicy?: TaskNotifyPolicy;
  deliveryStatus?: TaskDeliveryStatus;
  launch?: FlowTaskLaunch;
  startedAt?: number;
  lastEventAt?: number;
  progressSummary?: string | null;
  currentStep?: string;
}): { flow: FlowRecord; task: TaskRecord } {
  const flow = requireLinearFlow(params.flowId);
  const launch = params.launch ?? "queued";
  const task =
    launch === "running"
      ? createRunningTaskRun({
          runtime: params.runtime,
          sourceId: params.sourceId,
          requesterSessionKey: flow.ownerSessionKey,
          requesterOrigin: flow.requesterOrigin,
          parentFlowId: flow.flowId,
          childSessionKey: params.childSessionKey,
          parentTaskId: params.parentTaskId,
          agentId: params.agentId,
          runId: params.runId,
          label: params.label,
          task: params.task,
          preferMetadata: params.preferMetadata,
          notifyPolicy: params.notifyPolicy ?? flow.notifyPolicy,
          deliveryStatus: params.deliveryStatus,
          startedAt: params.startedAt,
          lastEventAt: params.lastEventAt,
          progressSummary: params.progressSummary,
        })
      : createQueuedTaskRun({
          runtime: params.runtime,
          sourceId: params.sourceId,
          requesterSessionKey: flow.ownerSessionKey,
          requesterOrigin: flow.requesterOrigin,
          parentFlowId: flow.flowId,
          childSessionKey: params.childSessionKey,
          parentTaskId: params.parentTaskId,
          agentId: params.agentId,
          runId: params.runId,
          label: params.label,
          task: params.task,
          preferMetadata: params.preferMetadata,
          notifyPolicy: params.notifyPolicy ?? flow.notifyPolicy,
          deliveryStatus: params.deliveryStatus,
        });
  return {
    task,
    flow: updateRequiredFlow(flow.flowId, {
      status: "waiting",
      currentStep: params.currentStep ?? flow.currentStep ?? "wait_for_task",
      waitingOnTaskId: task.taskId,
      blockedTaskId: null,
      blockedSummary: null,
      endedAt: null,
      updatedAt: task.lastEventAt ?? task.startedAt ?? Date.now(),
    }),
  };
}

export function setFlowWaiting(params: {
  flowId: string;
  currentStep?: string | null;
  waitingOnTaskId?: string | null;
  updatedAt?: number;
}): FlowRecord {
  const flow = requireLinearFlow(params.flowId);
  if (params.waitingOnTaskId?.trim()) {
    const waitingOnTaskId = params.waitingOnTaskId.trim();
    const linkedTaskIds = new Set(listTasksForFlowId(flow.flowId).map((task) => task.taskId));
    if (!linkedTaskIds.has(waitingOnTaskId)) {
      throw new Error(`Flow ${flow.flowId} is not linked to task ${waitingOnTaskId}`);
    }
  }
  return updateRequiredFlow(flow.flowId, {
    status: "waiting",
    currentStep: params.currentStep,
    waitingOnTaskId: params.waitingOnTaskId,
    endedAt: null,
    updatedAt: params.updatedAt ?? Date.now(),
  });
}

export function setFlowOutput(params: {
  flowId: string;
  key: string;
  value: FlowOutputValue;
  updatedAt?: number;
}): FlowRecord {
  const flow = requireLinearFlow(params.flowId);
  const key = params.key.trim();
  if (!key) {
    throw new Error("Flow output key is required.");
  }
  const outputs = resolveFlowOutputs(flow);
  outputs[key] = cloneOutputValue(params.value);
  return updateRequiredFlow(flow.flowId, {
    outputs,
    updatedAt: params.updatedAt ?? Date.now(),
  });
}

export function appendFlowOutput(params: {
  flowId: string;
  key: string;
  value: FlowOutputValue;
  updatedAt?: number;
}): FlowRecord {
  const flow = requireLinearFlow(params.flowId);
  const key = params.key.trim();
  if (!key) {
    throw new Error("Flow output key is required.");
  }
  const outputs = resolveFlowOutputs(flow);
  const nextValue = cloneOutputValue(params.value);
  const current = outputs[key];
  if (current === undefined) {
    outputs[key] = [nextValue];
  } else if (Array.isArray(current)) {
    outputs[key] = [...current, nextValue];
  } else {
    throw new Error(`Flow output ${key} is not an array.`);
  }
  return updateRequiredFlow(flow.flowId, {
    outputs,
    updatedAt: params.updatedAt ?? Date.now(),
  });
}

export function resumeFlow(params: {
  flowId: string;
  currentStep?: string | null;
  updatedAt?: number;
}): FlowRecord {
  const flow = requireLinearFlow(params.flowId);
  return updateRequiredFlow(flow.flowId, {
    status: "running",
    currentStep: params.currentStep,
    waitingOnTaskId: null,
    blockedTaskId: null,
    blockedSummary: null,
    endedAt: null,
    updatedAt: params.updatedAt ?? Date.now(),
  });
}

export function finishFlow(params: {
  flowId: string;
  currentStep?: string | null;
  updatedAt?: number;
  endedAt?: number;
}): FlowRecord {
  const flow = requireLinearFlow(params.flowId);
  const endedAt = params.endedAt ?? params.updatedAt ?? Date.now();
  return updateRequiredFlow(flow.flowId, {
    status: "succeeded",
    currentStep: params.currentStep,
    waitingOnTaskId: null,
    blockedTaskId: null,
    blockedSummary: null,
    updatedAt: params.updatedAt ?? endedAt,
    endedAt,
  });
}

export function failFlow(params: {
  flowId: string;
  currentStep?: string | null;
  updatedAt?: number;
  endedAt?: number;
}): FlowRecord {
  const flow = requireLinearFlow(params.flowId);
  const endedAt = params.endedAt ?? params.updatedAt ?? Date.now();
  return updateRequiredFlow(flow.flowId, {
    status: "failed",
    currentStep: params.currentStep,
    waitingOnTaskId: null,
    blockedTaskId: null,
    blockedSummary: null,
    updatedAt: params.updatedAt ?? endedAt,
    endedAt,
  });
}

export async function emitFlowUpdate(params: {
  flowId: string;
  content: string;
  eventKey?: string;
  currentStep?: string | null;
  updatedAt?: number;
}): Promise<{ flow: FlowRecord; delivery: FlowUpdateDelivery }> {
  const flow = requireFlow(params.flowId);
  const content = params.content.trim();
  if (!content) {
    throw new Error("Flow update content is required.");
  }
  const ownerSessionKey = flow.ownerSessionKey.trim();
  const updatedAt = params.updatedAt ?? Date.now();
  const updatedFlow = updateRequiredFlow(flow.flowId, {
    currentStep: params.currentStep,
    updatedAt,
  });
  if (!ownerSessionKey) {
    return {
      flow: updatedFlow,
      delivery: "parent_missing",
    };
  }
  if (!canDeliverFlowToRequesterOrigin(updatedFlow)) {
    try {
      enqueueSystemEvent(content, {
        sessionKey: ownerSessionKey,
        contextKey: `flow:${updatedFlow.flowId}`,
        deliveryContext: updatedFlow.requesterOrigin,
      });
      requestHeartbeatNow({
        reason: "clawflow-update",
        sessionKey: ownerSessionKey,
      });
      return {
        flow: updatedFlow,
        delivery: "session_queued",
      };
    } catch {
      return {
        flow: updatedFlow,
        delivery: "failed",
      };
    }
  }
  try {
    const requesterAgentId = parseAgentSessionKey(ownerSessionKey)?.agentId;
    const idempotencyKey = `flow:${updatedFlow.flowId}:update:${params.eventKey?.trim() || updatedAt}`;
    const { sendMessage } = await loadFlowDeliveryRuntime();
    await sendMessage({
      channel: updatedFlow.requesterOrigin?.channel,
      to: updatedFlow.requesterOrigin?.to ?? "",
      accountId: updatedFlow.requesterOrigin?.accountId,
      threadId: updatedFlow.requesterOrigin?.threadId,
      content,
      agentId: requesterAgentId,
      idempotencyKey,
      mirror: {
        sessionKey: ownerSessionKey,
        agentId: requesterAgentId,
        idempotencyKey,
      },
    });
    return {
      flow: updatedFlow,
      delivery: "direct",
    };
  } catch {
    try {
      enqueueSystemEvent(content, {
        sessionKey: ownerSessionKey,
        contextKey: `flow:${updatedFlow.flowId}`,
        deliveryContext: updatedFlow.requesterOrigin,
      });
      requestHeartbeatNow({
        reason: "clawflow-update",
        sessionKey: ownerSessionKey,
      });
      return {
        flow: updatedFlow,
        delivery: "session_queued",
      };
    } catch {
      return {
        flow: updatedFlow,
        delivery: "failed",
      };
    }
  }
}
