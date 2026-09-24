import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { shouldRouteCompletionThroughRequesterSession } from "../auto-reply/reply/completion-delivery-policy.js";
import { channelSupportsThreadDelivery } from "../channels/thread-addressing.js";
import { requestHeartbeat } from "../infra/heartbeat-wake.js";
import { withSystemEventOwner } from "../infra/system-event-ownership.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import { isDeliverableMessageChannel } from "../utils/message-channel.js";
import { readTaskBackingInstance } from "./task-backing-records.js";
import {
  formatTaskBlockedFollowupMessage,
  formatTaskStateChangeMessage,
  formatTaskTerminalMessage,
  shouldAutoDeliverTaskStateChange,
  shouldAutoDeliverTaskTerminalUpdate,
  shouldSuppressDuplicateTerminalDelivery,
  shouldUseParentReviewTaskTerminalMessage,
} from "./task-executor-policy.js";
import type { TaskFlowRecord } from "./task-flow-registry.types.js";
import { getTaskFlowById } from "./task-flow-runtime-internal.js";
import {
  captureTaskNotificationMutationOwner,
  settleNotificationMutationAfterPreparationFailure,
} from "./task-notification-mutation.async.js";
import {
  captureTaskNotificationTarget,
  matchesTaskNotificationTarget,
  type TaskNotificationTarget,
} from "./task-notification.operation.js";
import { runTaskDeliveryWithDetachedAdmission } from "./task-registry-delivery-admission.js";
import { getTaskDeliveryState, updateTask } from "./task-registry-mutation.js";
import { cloneTaskRecord, pickPreferredRunIdTask } from "./task-registry-records.js";
import { loadTaskRegistryDeliveryRuntime } from "./task-registry-runtime-loaders.js";
import {
  ensureTaskRegistryReady,
  getTasksByRunId,
  withTaskRegistryMutation,
  taskRegistryLog,
  taskDeliveryStates,
  tasks,
  tasksWithPendingDelivery,
} from "./task-registry-state.js";
import type {
  TaskDeliveryState,
  TaskDeliveryStatus,
  TaskEventRecord,
  TaskRecord,
} from "./task-registry.types.js";
import { resolveTaskSessionAgentId } from "./task-session-identity.js";

type NotificationMutationOwner = ReturnType<typeof captureTaskNotificationMutationOwner>;

type TaskDeliveryOwner = {
  sessionKey?: string;
  agentId?: string;
  requesterOrigin?: TaskDeliveryState["requesterOrigin"];
  flowId?: string;
};

function resolveTaskStateChangeIdempotencyKey(params: {
  task: TaskRecord;
  latestEvent: TaskEventRecord;
  owner: TaskDeliveryOwner;
}): string {
  if (params.owner.flowId) {
    return `flow-event:${params.owner.flowId}:${params.task.taskId}:${params.latestEvent.at}:${params.latestEvent.kind}`;
  }
  return `task-event:${params.task.taskId}:${params.latestEvent.at}:${params.latestEvent.kind}`;
}

function resolveTaskTerminalIdempotencyKey(task: TaskRecord, owner: TaskDeliveryOwner): string {
  const prefix = owner.flowId ? `flow-terminal:${owner.flowId}` : "task-terminal";
  const outcome = task.status === "succeeded" ? (task.terminalOutcome ?? "default") : "default";
  return `${prefix}:${task.taskId}:${task.status}:${outcome}`;
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

function canDeliverTaskToRequesterOrigin(owner: TaskDeliveryOwner): boolean {
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

function canDeliverParentReviewTaskToThreadOrigin(
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

function resolveMissingOwnerDeliveryStatus(task: TaskRecord): TaskDeliveryStatus {
  return task.scopeKind === "system" ? "not_applicable" : "parent_missing";
}

function queueTaskSystemEvent(
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

function queueBlockedTaskFollowup(task: TaskRecord, owner: TaskDeliveryOwner) {
  const followupText = formatTaskBlockedFollowupMessage(task);
  if (!followupText) {
    return false;
  }
  return queueTaskSystemEvent(task, followupText, owner, "background-task-blocked");
}

export async function maybeDeliverTaskTerminalUpdate(taskId: string): Promise<TaskRecord | null> {
  return await runTaskDeliveryWithDetachedAdmission(taskId, async () =>
    maybeDeliverTaskTerminalUpdateUnderAdmission(taskId),
  );
}

type TaskTerminalDelivery = {
  latest: TaskRecord;
  owner: TaskDeliveryOwner;
  ownerSessionKey: string;
  shouldDeliverParentReviewDirect: boolean;
  sessionEventText: string;
};
function getPeerTasksForDelivery(task: TaskRecord): TaskRecord[] {
  if (!task.runId?.trim()) {
    return [];
  }
  return getTasksByRunId(task.runId).filter(
    (candidate) =>
      candidate.runtime === task.runtime &&
      candidate.scopeKind === task.scopeKind &&
      (normalizeOptionalString(candidate.ownerKey) ?? "") ===
        (normalizeOptionalString(task.ownerKey) ?? "") &&
      (normalizeOptionalString(candidate.childSessionKey) ?? "") ===
        (normalizeOptionalString(task.childSessionKey) ?? ""),
  );
}

type PreparedTaskTerminalDelivery = { result: TaskRecord | null } | TaskTerminalDelivery;

type ReadSubagentRun =
  (typeof import("../agents/subagents/registry/subagent-registry-read.js"))["getLatestSubagentRunByChildSessionKey"];

function isSubagentSettlementPending(task: TaskRecord, readSubagentRun?: ReadSubagentRun): boolean {
  if (task.runtime !== "subagent" || !task.runId || !task.childSessionKey || !readSubagentRun) {
    return false;
  }
  const entry = readSubagentRun(task.childSessionKey);
  const backing = readTaskBackingInstance(task.detail);
  return Boolean(
    entry?.requesterSettleWake &&
    (entry.taskRunId ?? entry.runId) === task.runId &&
    entry.requesterSessionKey === task.ownerKey &&
    (backing?.runtime !== "subagent" || entry.generation === backing.generation),
  );
}

function prepareTaskTerminalDelivery(
  taskId: string,
  readSubagentRun?: ReadSubagentRun,
): PreparedTaskTerminalDelivery {
  const latest = tasks.get(taskId);
  if (
    !latest ||
    !shouldAutoDeliverTaskTerminalUpdate(latest) ||
    isSubagentSettlementPending(latest, readSubagentRun)
  ) {
    return { result: latest ? cloneTaskRecord(latest) : null };
  }
  const peers = latest.runId ? getPeerTasksForDelivery(latest) : [];
  const isSubagentCancellation = latest.runtime === "subagent" && latest.status === "cancelled";
  const preferred = pickPreferredRunIdTask(
    isSubagentCancellation
      ? peers.filter((candidate) => shouldAutoDeliverTaskTerminalUpdate(candidate))
      : peers,
  );
  const peerDeliveryCovered =
    isSubagentCancellation &&
    peers.some(
      (candidate) =>
        candidate.taskId !== latest.taskId &&
        (candidate.deliveryStatus === "delivered" || candidate.deliveryStatus === "session_queued"),
    );
  if (
    shouldSuppressDuplicateTerminalDelivery({
      task: latest,
      preferredTaskId: preferred?.taskId,
      peerDeliveryCovered,
    })
  ) {
    return {
      result: updateTask(taskId, { deliveryStatus: "not_applicable", lastEventAt: Date.now() }),
    };
  }
  const owner = resolveTaskDeliveryOwner(latest);
  const ownerSessionKey = owner.sessionKey?.trim();
  if (!ownerSessionKey) {
    return {
      result: updateTask(taskId, {
        deliveryStatus: resolveMissingOwnerDeliveryStatus(latest),
        lastEventAt: Date.now(),
      }),
    };
  }
  const shouldRouteParentReview = shouldUseParentReviewTaskTerminalMessage(latest);
  const shouldDeliverParentReviewDirect = canDeliverParentReviewTaskToThreadOrigin(latest, owner);
  const canDeliverDirect =
    canDeliverTaskToRequesterOrigin(owner) || shouldDeliverParentReviewDirect;
  const sessionEventText = formatTaskTerminalMessage(
    latest,
    shouldRouteParentReview ? { surface: "parent_session" } : undefined,
  );
  if ((shouldRouteParentReview && !shouldDeliverParentReviewDirect) || !canDeliverDirect) {
    try {
      queueTaskSystemEvent(latest, sessionEventText, owner);
      if (latest.terminalOutcome === "blocked") {
        queueBlockedTaskFollowup(latest, owner);
      }
      return {
        result: updateTask(taskId, {
          deliveryStatus:
            shouldRouteParentReview && canDeliverDirect ? "pending" : "session_queued",
          lastEventAt: Date.now(),
        }),
      };
    } catch (error) {
      taskRegistryLog.warn("Failed to queue background task session delivery", {
        taskId,
        ownerKey: latest.ownerKey,
        error,
      });
      return { result: updateTask(taskId, { deliveryStatus: "failed", lastEventAt: Date.now() }) };
    }
  }
  return { latest, owner, ownerSessionKey, shouldDeliverParentReviewDirect, sessionEventText };
}

async function maybeDeliverTaskTerminalUpdateUnderAdmission(
  taskId: string,
): Promise<TaskRecord | null> {
  let claimed = false;
  try {
    const early = withTaskRegistryMutation(
      () => {
        ensureTaskRegistryReady();
        const current = tasks.get(taskId);
        if (
          !current ||
          !shouldAutoDeliverTaskTerminalUpdate(current) ||
          tasksWithPendingDelivery.has(taskId)
        ) {
          return current ? cloneTaskRecord(current) : null;
        }
        tasksWithPendingDelivery.add(taskId);
        claimed = true;
        return undefined;
      },
      () => null,
    );
    if (!claimed) {
      return early ?? null;
    }
    const candidate = tasks.get(taskId);
    // Native cancellation may still owe its requester a complete sibling batch.
    // Resolve its owner lazily, then recheck current rows at each delivery boundary.
    const readSubagentRun =
      candidate?.runtime === "subagent" && candidate.status === "cancelled"
        ? (await import("../agents/subagents/registry/subagent-registry-read.js"))
            .getLatestSubagentRunByChildSessionKey
        : undefined;
    let prepared = withTaskRegistryMutation(
      () => prepareTaskTerminalDelivery(taskId, readSubagentRun),
      () => ({ result: null }),
    );
    if ("result" in prepared) {
      return prepared.result;
    }
    try {
      const { sendMessage, resolveTaskControlUiSessionUrl } =
        await loadTaskRegistryDeliveryRuntime();
      const invocation: {
        send?: { facts: TaskTerminalDelivery; pending: ReturnType<typeof sendMessage> };
        cleanupFailure?: { error: unknown };
      } = {};
      let immediate: TaskRecord | null | undefined;
      try {
        immediate = withTaskRegistryMutation(
          () => {
            // Runtime loading may admit another task with the preferred delivery claim.
            const fresh = prepareTaskTerminalDelivery(taskId, readSubagentRun);
            prepared = fresh;
            if ("result" in fresh) {
              return fresh.result;
            }
            const {
              latest,
              owner,
              ownerSessionKey,
              shouldDeliverParentReviewDirect,
              sessionEventText,
            } = fresh;
            const requesterAgentId = owner.agentId;
            const inspectUrl = latest.childSessionKey
              ? resolveTaskControlUiSessionUrl({
                  sessionKey: latest.childSessionKey,
                  fallbackAgentId:
                    parseAgentSessionKey(latest.childSessionKey)?.agentId ?? requesterAgentId,
                })
              : undefined;
            const directEventText = shouldDeliverParentReviewDirect
              ? sessionEventText
              : formatTaskTerminalMessage(latest);
            const idempotencyKey = resolveTaskTerminalIdempotencyKey(latest, owner);
            invocation.send = {
              facts: fresh,
              pending: sendMessage({
                channel: owner.requesterOrigin?.channel,
                to: owner.requesterOrigin?.to ?? "",
                accountId: owner.requesterOrigin?.accountId,
                threadId: owner.requesterOrigin?.threadId,
                content: inspectUrl
                  ? `${directEventText}\nInspect: ${inspectUrl}`
                  : directEventText,
                agentId: requesterAgentId,
                idempotencyKey,
                mirror: { sessionKey: ownerSessionKey, agentId: requesterAgentId, idempotencyKey },
              }),
            };
            return undefined;
          },
          () => null,
        );
      } catch (error) {
        if (!invocation.send) {
          throw error;
        }
        invocation.cleanupFailure = { error };
      }
      if (!invocation.send) {
        return immediate ?? null;
      }
      const { owner, ownerSessionKey } = invocation.send.facts;
      const sendResult = await invocation.send.pending.catch((error: unknown) => {
        if (invocation.cleanupFailure) {
          throw new AggregateError(
            [invocation.cleanupFailure.error, error],
            "Task delivery and coordinator cleanup failed",
            { cause: invocation.cleanupFailure.error },
          );
        }
        throw error;
      });
      if (invocation.cleanupFailure) {
        taskRegistryLog.warn("Background task delivery settled after coordinator cleanup failed", {
          taskId,
          error: invocation.cleanupFailure.error,
        });
      }
      return withTaskRegistryMutation(
        () => {
          const afterSend = tasks.get(taskId);
          if (!afterSend || !shouldAutoDeliverTaskTerminalUpdate(afterSend)) {
            return afterSend ? cloneTaskRecord(afterSend) : null;
          }
          if (sendResult.deliveryStatus === "suppressed") {
            if (sendResult.suppressionReason === "adapter_returned_no_identity") {
              taskRegistryLog.warn("Background task update delivery was not confirmed", {
                taskId,
                ownerKey: ownerSessionKey,
                requesterOrigin: owner.requesterOrigin,
                suppressionReason: sendResult.suppressionReason,
              });
              return updateTask(taskId, { deliveryStatus: "failed", lastEventAt: Date.now() });
            }
            throw new Error(
              `background task update suppressed: ${sendResult.suppressionReason ?? "unknown reason"}`,
            );
          }
          if (afterSend.terminalOutcome === "blocked") {
            queueBlockedTaskFollowup(afterSend, resolveTaskDeliveryOwner(afterSend));
          }
          return updateTask(taskId, { deliveryStatus: "delivered", lastEventAt: Date.now() });
        },
        () => null,
      );
    } catch (error) {
      const previous = prepared;
      return withTaskRegistryMutation(
        () => {
          taskRegistryLog.warn("Failed to deliver background task update", {
            taskId,
            ...("result" in previous
              ? {}
              : {
                  ownerKey: previous.ownerSessionKey,
                  requesterOrigin: previous.owner.requesterOrigin,
                }),
            error,
          });
          const beforeFallback = tasks.get(taskId);
          if (
            !beforeFallback ||
            !shouldAutoDeliverTaskTerminalUpdate(beforeFallback) ||
            isSubagentSettlementPending(beforeFallback, readSubagentRun)
          ) {
            return beforeFallback ? cloneTaskRecord(beforeFallback) : null;
          }
          try {
            const fallbackOwner = resolveTaskDeliveryOwner(beforeFallback);
            const sessionEventText = formatTaskTerminalMessage(
              beforeFallback,
              shouldUseParentReviewTaskTerminalMessage(beforeFallback)
                ? { surface: "parent_session" }
                : undefined,
            );
            queueTaskSystemEvent(beforeFallback, sessionEventText, fallbackOwner);
            if (beforeFallback.terminalOutcome === "blocked") {
              queueBlockedTaskFollowup(beforeFallback, fallbackOwner);
            }
          } catch (fallbackError) {
            taskRegistryLog.warn("Failed to queue background task fallback event", {
              taskId,
              ownerKey: beforeFallback.ownerKey,
              error: fallbackError,
            });
          }
          return updateTask(taskId, { deliveryStatus: "failed", lastEventAt: Date.now() });
        },
        () => null,
      );
    }
  } finally {
    if (claimed) {
      tasksWithPendingDelivery.delete(taskId);
    }
  }
}

export async function maybeDeliverTaskStateChangeUpdate(
  task: TaskRecord,
  latestEvent?: TaskEventRecord,
): Promise<TaskRecord | null> {
  const expectedTask = captureTaskNotificationTarget(task);
  const requestedEvent = latestEvent ? Object.freeze({ ...latestEvent }) : undefined;
  return await runTaskDeliveryWithDetachedAdmission(expectedTask.taskId, async (assertCurrent) =>
    maybeDeliverTaskStateChangeUpdateUnderAdmission(expectedTask, requestedEvent, assertCurrent),
  );
}

type TaskStateChangeDelivery = {
  current: TaskRecord;
  latestEvent: TaskEventRecord;
  owner: TaskDeliveryOwner;
  ownerSessionKey: string;
  eventText: string;
  queued: false | Promise<TaskRecord | null>;
  acknowledge: () => Promise<TaskRecord | null>;
};
type PreparedTaskStateChangeDelivery = { result: TaskRecord | null } | TaskStateChangeDelivery;

function prepareTaskStateChangeDelivery(
  expectedTask: TaskNotificationTarget,
  latestEvent: TaskEventRecord | undefined,
  mutation: NotificationMutationOwner,
): PreparedTaskStateChangeDelivery {
  const { taskId } = expectedTask;
  const current = tasks.get(taskId);
  if (
    !matchesTaskNotificationTarget(current, expectedTask) ||
    !shouldAutoDeliverTaskStateChange(current)
  ) {
    return { result: current ? cloneTaskRecord(current) : null };
  }
  const deliveryState = getTaskDeliveryState(taskId);
  if (!latestEvent || (deliveryState?.lastNotifiedEventAt ?? 0) >= latestEvent.at) {
    return { result: cloneTaskRecord(current) };
  }
  const event = latestEvent;
  const eventText = formatTaskStateChangeMessage(current, event);
  if (!eventText) {
    return { result: cloneTaskRecord(current) };
  }
  try {
    const owner = resolveTaskDeliveryOwner(current);
    const ownerSessionKey = owner.sessionKey?.trim();
    if (!ownerSessionKey) {
      return {
        result: updateTask(taskId, {
          deliveryStatus: resolveMissingOwnerDeliveryStatus(current),
          lastEventAt: Date.now(),
        }),
      };
    }
    const acknowledge = mutation.bindStateChange(current, event.at);
    const prepared = {
      current,
      latestEvent: event,
      owner,
      ownerSessionKey,
      eventText,
      acknowledge,
    };
    if (!canDeliverTaskToRequesterOrigin(owner)) {
      queueTaskSystemEvent(current, eventText, owner);
      return { ...prepared, queued: acknowledge() };
    }
    return { ...prepared, queued: false };
  } catch (error) {
    taskRegistryLog.warn("Failed to deliver background task state change", {
      taskId,
      ownerKey: current.ownerKey,
      error,
    });
    return { result: cloneTaskRecord(current) };
  }
}

async function maybeDeliverTaskStateChangeUpdateUnderAdmission(
  expectedTask: TaskNotificationTarget,
  latestEvent: TaskEventRecord | undefined,
  assertCurrent: () => void,
): Promise<TaskRecord | null> {
  const { taskId } = expectedTask;
  const mutation = captureTaskNotificationMutationOwner(assertCurrent);
  let pendingMutation: Promise<TaskRecord | null> | undefined;
  let initial: PreparedTaskStateChangeDelivery;
  try {
    initial = await mutation.prepare(() =>
      withTaskRegistryMutation(
        () => {
          ensureTaskRegistryReady();
          const prepared = prepareTaskStateChangeDelivery(expectedTask, latestEvent, mutation);
          if (!("result" in prepared) && prepared.queued) {
            pendingMutation = prepared.queued;
          }
          return prepared;
        },
        () => ({ result: null }),
      ),
    );
  } catch (error) {
    await settleNotificationMutationAfterPreparationFailure(pendingMutation, error);
    throw error;
  }
  if ("result" in initial) {
    return initial.result;
  }
  try {
    if (initial.queued) {
      return await initial.queued;
    }
    const { sendMessage } = await loadTaskRegistryDeliveryRuntime();
    const invocation: {
      send?: { facts: TaskStateChangeDelivery; pending: ReturnType<typeof sendMessage> };
      cleanupFailure?: { error: unknown };
    } = {};
    let immediate: TaskRecord | null | undefined;
    try {
      immediate = await mutation.prepare(() =>
        withTaskRegistryMutation(
          () => {
            assertCurrent();
            const fresh = prepareTaskStateChangeDelivery(expectedTask, latestEvent, mutation);
            if ("result" in fresh) {
              return fresh.result;
            }
            if (fresh.queued) {
              pendingMutation = fresh.queued;
              return undefined;
            }
            const { current, latestEvent: event, owner, ownerSessionKey, eventText } = fresh;
            const requesterAgentId = owner.agentId;
            const idempotencyKey = resolveTaskStateChangeIdempotencyKey({
              task: current,
              latestEvent: event,
              owner,
            });
            invocation.send = {
              facts: fresh,
              pending: sendMessage({
                channel: owner.requesterOrigin?.channel,
                to: owner.requesterOrigin?.to ?? "",
                accountId: owner.requesterOrigin?.accountId,
                threadId: owner.requesterOrigin?.threadId,
                content: eventText,
                agentId: requesterAgentId,
                idempotencyKey,
                mirror: { sessionKey: ownerSessionKey, agentId: requesterAgentId, idempotencyKey },
              }),
            };
            return undefined;
          },
          () => null,
        ),
      );
    } catch (error) {
      if (!invocation.send) {
        await settleNotificationMutationAfterPreparationFailure(pendingMutation, error);
        throw error;
      }
      invocation.cleanupFailure = { error };
    }
    if (!invocation.send) {
      return pendingMutation ? await pendingMutation : (immediate ?? null);
    }
    const { current, owner, acknowledge } = invocation.send.facts;
    const sendResult = await invocation.send.pending.catch((error: unknown) => {
      if (invocation.cleanupFailure) {
        throw new AggregateError(
          [invocation.cleanupFailure.error, error],
          "Task state-change delivery and coordinator cleanup failed",
          { cause: invocation.cleanupFailure.error },
        );
      }
      throw error;
    });
    if (invocation.cleanupFailure) {
      taskRegistryLog.warn(
        "Background task state change settled after coordinator cleanup failed",
        {
          taskId,
          error: invocation.cleanupFailure.error,
        },
      );
    }
    if (sendResult.deliveryStatus === "suppressed") {
      if (sendResult.suppressionReason !== "adapter_returned_no_identity") {
        throw new Error(
          `background task state change suppressed: ${sendResult.suppressionReason ?? "unknown reason"}`,
        );
      }
      taskRegistryLog.warn("Background task state change delivery was not confirmed", {
        taskId,
        ownerKey: current.ownerKey,
        requesterOrigin: owner.requesterOrigin,
        suppressionReason: sendResult.suppressionReason,
      });
    }
    return await acknowledge();
  } catch (error) {
    taskRegistryLog.warn("Failed to deliver background task state change", {
      taskId,
      ownerKey: initial.current.ownerKey,
      error,
    });
    const readCurrent = () => {
      const current = tasks.get(taskId);
      return current ? cloneTaskRecord(current) : null;
    };
    try {
      return await mutation.prepare(() => withTaskRegistryMutation(readCurrent, readCurrent));
    } catch {
      return readCurrent();
    }
  }
}
