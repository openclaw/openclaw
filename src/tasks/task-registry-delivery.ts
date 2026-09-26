import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { readTaskBackingInstance } from "./task-backing-records.js";
import {
  formatTaskStateChangeMessage,
  formatTaskTerminalMessage,
  shouldUseParentReviewTaskTerminalMessage,
} from "./task-executor-policy.js";
import type { TaskFlowRegistryRead } from "./task-flow-registry.read.js";
import {
  captureTaskNotificationMutationOwner,
  settleNotificationMutationAfterPreparationFailure,
} from "./task-notification-mutation.async.js";
import {
  shouldAutoDeliverTaskStateChange,
  shouldAutoDeliverTaskTerminalUpdate,
  shouldSuppressDuplicateTerminalDelivery,
} from "./task-notification-policy.js";
import {
  canDeliverParentReviewTaskToThreadOrigin,
  canDeliverTaskToRequesterOrigin,
  getPeerTasksForDelivery,
  queueBlockedTaskFollowup,
  queueTaskSystemEvent,
  resolveTaskDeliveryOwner,
  resolveTaskStateChangeIdempotencyKey,
  resolveTaskTerminalIdempotencyKey,
  type TaskDeliveryOwner,
} from "./task-notification-routing.js";
import {
  captureTaskNotificationTarget,
  matchesTaskNotificationTarget,
  type TaskNotificationTarget,
} from "./task-notification.operation.js";
import { runTaskDeliveryWithDetachedAdmission } from "./task-registry-delivery-admission.js";
import { getTaskDeliveryState } from "./task-registry-mutation.js";
import { cloneTaskRecord, pickPreferredRunIdTask } from "./task-registry-records.js";
import { deliveryRuntimeLoader } from "./task-registry-runtime-loaders.js";
import { taskRegistryLog, tasks, tasksWithPendingDelivery } from "./task-registry-state.js";
import type { TaskDeliveryStatus, TaskEventRecord, TaskRecord } from "./task-registry.types.js";

type NotificationMutationOwner = ReturnType<typeof captureTaskNotificationMutationOwner>;
type PendingNotificationMutation = { pending: Promise<TaskRecord | null> };

function resolveMissingOwnerDeliveryStatus(task: TaskRecord): "parent_missing" | "not_applicable" {
  return task.scopeKind === "system" ? "not_applicable" : "parent_missing";
}

export function maybeDeliverTaskTerminalUpdate(taskId: string): Promise<TaskRecord | null> {
  return runTaskDeliveryWithDetachedAdmission(taskId, async (assertCurrent) =>
    maybeDeliverTaskTerminalUpdateUnderAdmission(taskId, assertCurrent),
  );
}

type TaskTerminalDelivery = {
  latest: TaskRecord;
  owner: TaskDeliveryOwner;
  ownerSessionKey: string;
  shouldDeliverParentReviewDirect: boolean;
  sessionEventText: string;
};

type PreparedTaskTerminalDelivery =
  | { result: TaskRecord | null }
  | PendingNotificationMutation
  | TaskTerminalDelivery;

type ReadSubagentRun = () => SubagentRunRecord | null;

function isSubagentSettlementPending(task: TaskRecord, readSubagentRun?: ReadSubagentRun): boolean {
  if (task.runtime !== "subagent" || !task.runId || !task.childSessionKey || !readSubagentRun) {
    return false;
  }
  const entry = readSubagentRun();
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
  expectedTask: TaskNotificationTarget,
  mutation: NotificationMutationOwner,
  flows: TaskFlowRegistryRead,
  readSubagentRun?: ReadSubagentRun,
): PreparedTaskTerminalDelivery {
  const latest = tasks.get(taskId);
  if (
    !matchesTaskNotificationTarget(latest, expectedTask) ||
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
      pending: mutation.updateDelivery(latest, {
        kind: "terminal",
        deliveryStatus: "not_applicable",
      }),
    };
  }
  const owner = resolveTaskDeliveryOwner(latest, flows.getTaskFlowById);
  const ownerSessionKey = owner.sessionKey?.trim();
  if (!ownerSessionKey) {
    return {
      pending: mutation.updateDelivery(latest, {
        kind: "terminal",
        deliveryStatus: resolveMissingOwnerDeliveryStatus(latest),
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
    let deliveryStatus: TaskDeliveryStatus =
      shouldRouteParentReview && canDeliverDirect ? "pending" : "session_queued";
    try {
      queueTaskSystemEvent(latest, sessionEventText, owner);
      if (latest.terminalOutcome === "blocked") {
        queueBlockedTaskFollowup(latest, owner);
      }
    } catch (error) {
      taskRegistryLog.warn("Failed to queue background task session delivery", {
        taskId,
        ownerKey: latest.ownerKey,
        error,
      });
      deliveryStatus = "failed";
    }
    return { pending: mutation.updateDelivery(latest, { kind: "terminal", deliveryStatus }) };
  }
  return { latest, owner, ownerSessionKey, shouldDeliverParentReviewDirect, sessionEventText };
}

async function finishTerminalNotificationMutation(
  taskId: string,
  pending: Promise<TaskRecord | null>,
): Promise<TaskRecord | null> {
  try {
    return await pending;
  } catch (error) {
    // A sent or queued notification must not be replayed because its storage outcome failed.
    taskRegistryLog.warn("Failed to persist background task delivery", { taskId, error });
    return null;
  }
}

async function maybeDeliverTaskTerminalUpdateUnderAdmission(
  taskId: string,
  assertDeliveryCurrent: () => void,
): Promise<TaskRecord | null> {
  let claim: symbol | undefined;
  let expectedTask: TaskNotificationTarget | undefined;
  let retiredClaimError: Error | undefined;
  const assertCurrent = () => {
    assertDeliveryCurrent();
    if (claim && tasksWithPendingDelivery.get(taskId) !== claim) {
      retiredClaimError ??= new Error("Task terminal delivery no longer owns its pending claim");
      throw retiredClaimError;
    }
  };
  const mutation = captureTaskNotificationMutationOwner(assertCurrent);
  try {
    const early = await mutation.prepare(() => {
      const current = tasks.get(taskId);
      if (
        !current ||
        !shouldAutoDeliverTaskTerminalUpdate(current) ||
        tasksWithPendingDelivery.has(taskId)
      ) {
        return current ? cloneTaskRecord(current) : null;
      }
      claim = Symbol("task terminal delivery");
      tasksWithPendingDelivery.set(taskId, claim);
      expectedTask = captureTaskNotificationTarget(current);
      return undefined;
    });
    if (!claim || !expectedTask) {
      return early ?? null;
    }
    const target = expectedTask;
    const subagentChildSessionKey =
      target.runtime === "subagent" ? target.childSessionKey : undefined;
    let initialMutation: Promise<TaskRecord | null> | undefined;
    let prepared: PreparedTaskTerminalDelivery;
    try {
      prepared = await mutation.prepare((flows, readSubagentRun) => {
        const result = prepareTaskTerminalDelivery(
          taskId,
          target,
          mutation,
          flows,
          readSubagentRun,
        );
        if ("pending" in result) {
          initialMutation = result.pending;
        }
        return result;
      }, subagentChildSessionKey);
    } catch (error) {
      await settleNotificationMutationAfterPreparationFailure(initialMutation, error);
      throw error;
    }
    if ("result" in prepared) {
      return prepared.result;
    }
    if ("pending" in prepared) {
      return await finishTerminalNotificationMutation(taskId, prepared.pending);
    }
    let startedMutation: Promise<TaskRecord | null> | undefined;
    let deliverySettled = false;
    try {
      const { sendMessage, prepareTaskControlUiSessionUrl } = await deliveryRuntimeLoader.load();
      const resolveTaskControlUiSessionUrl = target.childSessionKey
        ? await prepareTaskControlUiSessionUrl(assertCurrent)
        : undefined;
      assertCurrent();
      const invocation: {
        send?: { facts: TaskTerminalDelivery; pending: ReturnType<typeof sendMessage> };
        cleanupFailure?: { error: unknown };
      } = {};
      let immediate: TaskRecord | null | undefined;
      try {
        immediate = await mutation.prepare((flows, readSubagentRun) => {
          const fresh = prepareTaskTerminalDelivery(
            taskId,
            target,
            mutation,
            flows,
            readSubagentRun,
          );
          prepared = fresh;
          if ("result" in fresh) {
            return fresh.result;
          }
          if ("pending" in fresh) {
            startedMutation = fresh.pending;
            return undefined;
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
            ? resolveTaskControlUiSessionUrl?.({
                sessionKey: latest.childSessionKey,
                fallbackAgentId:
                  parseAgentSessionKey(latest.childSessionKey)?.agentId ?? requesterAgentId,
              })
            : undefined;
          const directEventText = shouldDeliverParentReviewDirect
            ? sessionEventText
            : formatTaskTerminalMessage(latest);
          const idempotencyKey = resolveTaskTerminalIdempotencyKey(latest, owner);
          assertCurrent();
          const current = tasks.get(taskId);
          if (!matchesTaskNotificationTarget(current, target)) {
            return current ? cloneTaskRecord(current) : null;
          }
          invocation.send = {
            facts: fresh,
            pending: sendMessage({
              channel: owner.requesterOrigin?.channel,
              to: owner.requesterOrigin?.to ?? "",
              accountId: owner.requesterOrigin?.accountId,
              threadId: owner.requesterOrigin?.threadId,
              content: inspectUrl ? `${directEventText}\nInspect: ${inspectUrl}` : directEventText,
              agentId: requesterAgentId,
              idempotencyKey,
              mirror: {
                sessionKey: ownerSessionKey,
                agentId: requesterAgentId,
                idempotencyKey,
              },
            }),
          };
          return undefined;
        }, subagentChildSessionKey);
      } catch (error) {
        if (!invocation.send) {
          await settleNotificationMutationAfterPreparationFailure(startedMutation, error);
          throw error;
        }
        invocation.cleanupFailure = { error };
      }
      if (!invocation.send) {
        return startedMutation
          ? await finishTerminalNotificationMutation(taskId, startedMutation)
          : (immediate ?? null);
      }
      const { latest: sentTask, owner, ownerSessionKey } = invocation.send.facts;
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
      deliverySettled =
        sendResult.deliveryStatus !== "suppressed" ||
        sendResult.suppressionReason === "adapter_returned_no_identity";
      if (invocation.cleanupFailure) {
        taskRegistryLog.warn("Background task delivery settled after coordinator cleanup failed", {
          taskId,
          error: invocation.cleanupFailure.error,
        });
      }
      let afterDelivery: TaskRecord | null | undefined;
      try {
        afterDelivery = await mutation.prepare((flows) => {
          const afterSend = tasks.get(taskId);
          if (
            !matchesTaskNotificationTarget(afterSend, target) ||
            !shouldAutoDeliverTaskTerminalUpdate(afterSend)
          ) {
            return afterSend ? cloneTaskRecord(afterSend) : null;
          }
          let deliveryStatus: TaskDeliveryStatus = "delivered";
          if (sendResult.deliveryStatus === "suppressed") {
            if (sendResult.suppressionReason !== "adapter_returned_no_identity") {
              throw new Error(
                `background task update suppressed: ${sendResult.suppressionReason ?? "unknown reason"}`,
              );
            }
            taskRegistryLog.warn("Background task update delivery was not confirmed", {
              taskId,
              ownerKey: ownerSessionKey,
              requesterOrigin: owner.requesterOrigin,
              suppressionReason: sendResult.suppressionReason,
            });
            deliveryStatus = "failed";
          } else if (afterSend.terminalOutcome === "blocked") {
            queueBlockedTaskFollowup(
              afterSend,
              resolveTaskDeliveryOwner(afterSend, flows.getTaskFlowById),
            );
          }
          startedMutation = mutation.updateDelivery(sentTask, {
            kind: "terminal",
            deliveryStatus,
          });
          return undefined;
        });
      } catch (error) {
        await settleNotificationMutationAfterPreparationFailure(startedMutation, error);
        throw error;
      }
      return startedMutation
        ? await finishTerminalNotificationMutation(taskId, startedMutation)
        : (afterDelivery ?? null);
    } catch (error) {
      const previous = prepared;
      taskRegistryLog.warn("Failed to deliver background task update", {
        taskId,
        ...("owner" in previous
          ? { ownerKey: previous.ownerSessionKey, requesterOrigin: previous.owner.requesterOrigin }
          : {}),
        error,
      });
      if (startedMutation) {
        return await finishTerminalNotificationMutation(taskId, startedMutation);
      }
      if (deliverySettled) {
        // Keep authority checks, but never requeue an accepted or ambiguous transport result.
        return await mutation.prepare(() => null);
      }
      let fallbackMutation: Promise<TaskRecord | null> | undefined;
      let fallback: TaskRecord | null | undefined;
      try {
        fallback = await mutation.prepare((flows, readSubagentRun) => {
          const beforeFallback = tasks.get(taskId);
          if (
            !matchesTaskNotificationTarget(beforeFallback, target) ||
            !shouldAutoDeliverTaskTerminalUpdate(beforeFallback) ||
            isSubagentSettlementPending(beforeFallback, readSubagentRun)
          ) {
            return beforeFallback ? cloneTaskRecord(beforeFallback) : null;
          }
          try {
            const fallbackOwner = resolveTaskDeliveryOwner(beforeFallback, flows.getTaskFlowById);
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
          fallbackMutation = mutation.updateDelivery(beforeFallback, {
            kind: "terminal",
            deliveryStatus: "failed",
          });
          return undefined;
        }, subagentChildSessionKey);
      } catch (fallbackError) {
        await settleNotificationMutationAfterPreparationFailure(fallbackMutation, fallbackError);
        throw fallbackError;
      }
      return fallbackMutation
        ? await finishTerminalNotificationMutation(taskId, fallbackMutation)
        : (fallback ?? null);
    }
  } catch (error) {
    if (!retiredClaimError || error !== retiredClaimError) {
      throw error;
    }
    return null;
  } finally {
    if (claim && tasksWithPendingDelivery.get(taskId) === claim) {
      tasksWithPendingDelivery.delete(taskId);
    }
  }
}

export function maybeDeliverTaskStateChangeUpdate(
  task: TaskRecord,
  latestEvent?: TaskEventRecord,
): Promise<TaskRecord | null> {
  const expectedTask = captureTaskNotificationTarget(task);
  const requestedEvent = latestEvent ? Object.freeze({ ...latestEvent }) : undefined;
  return runTaskDeliveryWithDetachedAdmission(expectedTask.taskId, async (assertCurrent) =>
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
type PreparedTaskStateChangeDelivery =
  | { result: TaskRecord | null }
  | (PendingNotificationMutation & { current: TaskRecord })
  | TaskStateChangeDelivery;

function prepareTaskStateChangeDelivery(
  expectedTask: TaskNotificationTarget,
  latestEvent: TaskEventRecord | undefined,
  mutation: NotificationMutationOwner,
  flows: TaskFlowRegistryRead,
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
    const owner = resolveTaskDeliveryOwner(current, flows.getTaskFlowById);
    const ownerSessionKey = owner.sessionKey?.trim();
    if (!ownerSessionKey) {
      return {
        current,
        pending: mutation.updateDelivery(current, {
          kind: "missingStateOwner",
          deliveryStatus: resolveMissingOwnerDeliveryStatus(current),
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
    initial = await mutation.prepare((flows) => {
      const prepared = prepareTaskStateChangeDelivery(expectedTask, latestEvent, mutation, flows);
      if ("pending" in prepared) {
        pendingMutation = prepared.pending;
      } else if (!("result" in prepared) && prepared.queued) {
        pendingMutation = prepared.queued;
      }
      return prepared;
    });
  } catch (error) {
    await settleNotificationMutationAfterPreparationFailure(pendingMutation, error);
    throw error;
  }
  if ("result" in initial) {
    return initial.result;
  }
  try {
    if ("pending" in initial) {
      return await initial.pending;
    }
    if (initial.queued) {
      return await initial.queued;
    }
    const { sendMessage } = await deliveryRuntimeLoader.load();
    const invocation: {
      send?: { facts: TaskStateChangeDelivery; pending: ReturnType<typeof sendMessage> };
      cleanupFailure?: { error: unknown };
    } = {};
    let immediate: TaskRecord | null | undefined;
    try {
      immediate = await mutation.prepare((flows) => {
        assertCurrent();
        const fresh = prepareTaskStateChangeDelivery(expectedTask, latestEvent, mutation, flows);
        if ("result" in fresh) {
          return fresh.result;
        }
        if ("pending" in fresh) {
          pendingMutation = fresh.pending;
          return undefined;
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
      });
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
      return await mutation.prepare(readCurrent);
    } catch {
      return readCurrent();
    }
  }
}
