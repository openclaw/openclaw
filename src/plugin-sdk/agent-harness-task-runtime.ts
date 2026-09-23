/**
 * Runtime SDK helpers for agent harness task persistence and completion delivery.
 */
import { normalizeOptionalString } from "../../packages/normalization-core/src/string-coerce.js";
import { reconcileHarnessCompletionDelivery } from "../agents/agent-harness-completion-delivery.js";
import { buildAnnounceIdempotencyKey } from "../agents/announce-idempotency.js";
import {
  AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION,
  type AgentInternalEventStatus,
} from "../agents/internal-event-contract.js";
import {
  formatAgentInternalEventsForPrompt,
  type AgentInternalEvent,
} from "../agents/internal-events.js";
import {
  deliverSubagentAnnouncement,
  isInternalAnnounceRequesterSession,
  loadRequesterSessionEntry,
} from "../agents/subagents/announce/subagent-announce-delivery.js";
import {
  resolveAnnounceOrigin,
  resolveSubagentCompletionOrigin,
} from "../agents/subagents/announce/subagent-announce-origin.js";
import {
  getGatewayContextResolver,
  withPluginRuntimeGatewayContextResolver,
} from "../plugins/runtime/gateway-request-scope.js";
import {
  captureAgentHarnessCompletionCustodyOwner,
  isAgentHarnessCompletionCustodyCurrent,
  runWithAgentHarnessCompletionCustody,
  type AgentHarnessCompletionCustody,
} from "../tasks/agent-harness-completion-custody.js";
import {
  assertAgentHarnessTaskRuntimeScope,
  type AgentHarnessTaskRuntimeScope,
} from "../tasks/agent-harness-task-runtime-scope.js";
import { DetachedTaskAssignmentUnsupportedError } from "../tasks/detached-task-runtime-contract.js";
import { captureDetachedTaskRuntimeOwner } from "../tasks/detached-task-runtime-state.js";
import {
  createRunningTaskRun,
  finalizeTaskRunByRunId,
  recordTaskRunProgressByRunId,
  setDetachedTaskDeliveryStatusByRunId,
  transitionTaskAssignment,
} from "../tasks/detached-task-runtime.js";
import { listTaskRecords, type TaskRecord } from "../tasks/runtime-internal.js";
import { captureTaskExecutionOwner } from "../tasks/task-execution-owner.js";
import {
  captureTaskPersistenceReceipt,
  matchesTaskPersistenceReceipt,
} from "../tasks/task-registry-records.js";
import type { TaskPersistenceReceipt, TaskRunTransition } from "../tasks/task-registry.types.js";

export { createAgentHarnessTaskEventSink } from "../tasks/agent-harness-completion-custody.js";
export type { AgentHarnessCompletionCustody };
export {
  DetachedTaskAssignmentUnsupportedError as AgentHarnessTaskAssignmentUnsupportedError,
  DetachedTaskRuntimeOwnerRetiredError as AgentHarnessTaskAssignmentOwnerRetiredError,
} from "../tasks/detached-task-runtime-contract.js";
export type { TaskPersistenceReceipt as AgentHarnessTaskAssignment };
export {
  captureTaskPersistenceReceipt as captureAgentHarnessTaskAssignment,
  matchesTaskPersistenceReceipt as matchesAgentHarnessTaskAssignment,
} from "../tasks/task-registry-records.js";

type AssignmentOwnership = {
  /** Pin the record returned by admission, never rediscover it at completion. */
  expectedTask?: TaskPersistenceReceipt;
  completionCustody?: AgentHarnessCompletionCustody;
};

/** Retains admitted completion work for this exact physical requester lifecycle. */
export function captureAgentHarnessCompletionCustody(
  scope: AgentHarnessTaskRuntimeScope,
): AgentHarnessCompletionCustody | undefined {
  assertAgentHarnessTaskRuntimeScope(scope);
  const entry = loadRequesterSessionEntry(scope.requesterSessionKey).entry;
  const expected = { sessionId: entry?.sessionId, lifecycleRevision: entry?.lifecycleRevision };
  return captureAgentHarnessCompletionCustodyOwner(scope, () => {
    const current = loadRequesterSessionEntry(scope.requesterSessionKey).entry;
    if (
      current?.sessionId !== expected.sessionId ||
      current?.lifecycleRevision !== expected.lifecycleRevision
    ) {
      throw new Error("Harness completion requester lifecycle was replaced");
    }
  });
}

export type { TaskRecord as AgentHarnessTaskRecord };
export type { AgentHarnessTaskRuntimeScope };

type AgentHarnessTaskRuntimeId = Parameters<typeof createRunningTaskRun>[0]["runtime"];
type CreateRunningTaskRunParams = Parameters<typeof createRunningTaskRun>[0];
type RecordTaskRunProgressParams = Parameters<typeof recordTaskRunProgressByRunId>[0];
type FinalizeTaskRunParams = Parameters<typeof finalizeTaskRunByRunId>[0];
type SetDeliveryStatusParams = Parameters<typeof setDetachedTaskDeliveryStatusByRunId>[0];

/** Scope and naming options used to bind task operations to one requester session. */
export type AgentHarnessTaskRuntimeScopeParams = {
  scope: AgentHarnessTaskRuntimeScope;
  runIdPrefix?: string;
  /** Local harness process PID, when the transport owns and reports one. */
  executionPid?: number;
} & (
  | {
      // Core identifies harness-owned subagent rows by the taskKind stamped here
      // (isHarnessOwnedSubagentTask); a subagent row created without one would be
      // read as an OpenClaw-owned child session and reclaimed on the short grace.
      runtime: Extract<AgentHarnessTaskRuntimeId, "subagent">;
      taskKind: string;
    }
  | {
      runtime: Exclude<AgentHarnessTaskRuntimeId, "subagent">;
      taskKind?: string;
    }
);

/** Create-task params with runtime and requester scope supplied by the scoped task runtime. */
export type AgentHarnessScopedCreateRunningTaskRunParams = Omit<
  CreateRunningTaskRunParams,
  "runtime" | "taskKind" | "requesterSessionKey" | "ownerKey" | "scopeKind" | "executionOwner"
> & {
  runId: string;
};

/** Progress params scoped to the requester session owned by the harness runtime. */
export type AgentHarnessScopedRecordTaskRunProgressParams = Omit<
  RecordTaskRunProgressParams,
  "runtime" | "sessionKey"
> &
  AssignmentOwnership;

/** Finalization params scoped to the requester session owned by the harness runtime. */
export type AgentHarnessScopedFinalizeTaskRunParams = Omit<
  FinalizeTaskRunParams,
  "runtime" | "sessionKey"
> &
  AssignmentOwnership;

/** Delivery-status params scoped to the requester session owned by the harness runtime. */
export type AgentHarnessScopedSetDeliveryStatusParams = Omit<
  SetDeliveryStatusParams,
  "runtime" | "sessionKey"
> &
  AssignmentOwnership;

/** Scoped task runtime that prevents callers from mutating tasks outside their harness scope. */
export type AgentHarnessTaskRuntime = {
  /** Check the captured runtime before accepting work that requires exact settlement. */
  assertTaskAssignmentSupported(): void;
  createRunningTaskRun(params: AgentHarnessScopedCreateRunningTaskRunParams): TaskRecord;
  tryCreateRunningTaskRun(params: AgentHarnessScopedCreateRunningTaskRunParams): TaskRecord | null;
  recordTaskRunProgressByRunId(params: AgentHarnessScopedRecordTaskRunProgressParams): TaskRecord[];
  finalizeTaskRunByRunId(params: AgentHarnessScopedFinalizeTaskRunParams): TaskRecord[];
  setDetachedTaskDeliveryStatusByRunId(
    params: AgentHarnessScopedSetDeliveryStatusParams,
  ): TaskRecord[];
  listTaskRecords(): TaskRecord[];
};

/** Completion states a harness task can report to its requester. */
export type AgentHarnessCompletionStatus = "succeeded" | "failed" | "cancelled";

/** Delivery result returned after routing a harness task completion announcement. */
export type AgentHarnessCompletionDelivery = Awaited<
  ReturnType<typeof deliverSubagentAnnouncement>
> & { recoveryPending?: true; recoveryBlocked?: true };

const AGENT_HARNESS_COMPLETION_SOURCE_TOOL = "agent_harness_task";

/** Creates a task runtime whose run ids and task records are constrained to one scope. */
export function createAgentHarnessTaskRuntime(
  params: AgentHarnessTaskRuntimeScopeParams,
): AgentHarnessTaskRuntime {
  const runtime = params.runtime;
  const scope = assertAgentHarnessTaskRuntimeScope(params.scope);
  const requesterSessionKey = scope.requesterSessionKey;
  const taskKind = normalizeOptionalString(params.taskKind);
  const runIdPrefix = normalizeOptionalString(params.runIdPrefix);
  // Remote and unidentified harnesses must not inherit the Gateway's identity.
  const executionOwner =
    params.executionPid === undefined ? undefined : captureTaskExecutionOwner(params.executionPid);
  const runtimeOwner = captureDetachedTaskRuntimeOwner();
  const assertRunId = (runId: string) => assertScopedRunId(runId, runIdPrefix);
  const transitionAssignment = (
    transition: TaskRunTransition,
    ownership: AssignmentOwnership & { expectedTask: TaskPersistenceReceipt },
  ) =>
    transitionTaskAssignment({
      transition,
      expectedTask: ownership.expectedTask,
      assertCurrent() {
        runtimeOwner.assertCurrent();
        assertAgentHarnessTaskRuntimeScope(scope);
        if (
          ownership.expectedTask.runtime !== runtime ||
          ownership.expectedTask.ownerKey !== requesterSessionKey ||
          ownership.expectedTask.scopeKind !== "session" ||
          ownership.expectedTask.runId !== transition.params.runId ||
          (taskKind && ownership.expectedTask.taskKind !== taskKind) ||
          (ownership.completionCustody &&
            !isAgentHarnessCompletionCustodyCurrent(ownership.completionCustody, scope))
        ) {
          throw new Error("Harness task assignment owner is no longer current");
        }
      },
    });
  const tryCreateRunningTaskRun = (
    taskParams: AgentHarnessScopedCreateRunningTaskRunParams,
  ): TaskRecord | null => {
    assertRunId(taskParams.runId);
    return createRunningTaskRun({
      ...taskParams,
      runtime,
      ...(taskKind ? { taskKind } : {}),
      requesterSessionKey,
      ownerKey: requesterSessionKey,
      scopeKind: "session",
      executionOwner,
    });
  };
  return {
    assertTaskAssignmentSupported() {
      runtimeOwner.assertCurrent();
      if (runtimeOwner.runtime && !runtimeOwner.runtime.transitionTaskAssignment) {
        throw new DetachedTaskAssignmentUnsupportedError();
      }
    },
    createRunningTaskRun(taskParams) {
      const task = tryCreateRunningTaskRun(taskParams);
      if (!task) {
        throw new Error("Task persistence failed.");
      }
      return task;
    },
    tryCreateRunningTaskRun,
    recordTaskRunProgressByRunId(taskParams) {
      assertRunId(taskParams.runId);
      const { expectedTask, completionCustody, ...progress } = taskParams;
      if (expectedTask) {
        return transitionAssignment(
          { kind: "state", params: { ...progress, runtime, sessionKey: requesterSessionKey } },
          { expectedTask, completionCustody },
        );
      }
      return recordTaskRunProgressByRunId({
        ...progress,
        runtime,
        sessionKey: requesterSessionKey,
      });
    },
    finalizeTaskRunByRunId(taskParams) {
      assertRunId(taskParams.runId);
      const { expectedTask, completionCustody, ...terminal } = taskParams;
      if (expectedTask) {
        return transitionAssignment(
          { kind: "state", params: { ...terminal, runtime, sessionKey: requesterSessionKey } },
          { expectedTask, completionCustody },
        );
      }
      return finalizeTaskRunByRunId({
        ...terminal,
        runtime,
        sessionKey: requesterSessionKey,
      });
    },
    setDetachedTaskDeliveryStatusByRunId(taskParams) {
      assertRunId(taskParams.runId);
      const { expectedTask, completionCustody, ...delivery } = taskParams;
      if (expectedTask) {
        return transitionAssignment(
          { kind: "delivery", params: { ...delivery, runtime, sessionKey: requesterSessionKey } },
          { expectedTask, completionCustody },
        );
      }
      return setDetachedTaskDeliveryStatusByRunId({
        ...delivery,
        runtime,
        sessionKey: requesterSessionKey,
      });
    },
    listTaskRecords() {
      return listTaskRecords(
        (task) =>
          task.runtime === runtime &&
          (!taskKind || task.taskKind === taskKind) &&
          task.scopeKind === "session" &&
          task.ownerKey === requesterSessionKey &&
          (!runIdPrefix || task.runId?.startsWith(runIdPrefix) === true),
      );
    },
  };
}

/** Delivers a completed harness task result back to the requester or parent session. */
export async function deliverAgentHarnessTaskCompletion(params: {
  scope: AgentHarnessTaskRuntimeScope;
  /** Retained during live admission for this assignment, released by its lifecycle owner. */
  completionCustody?: AgentHarnessCompletionCustody;
  expectedTask?: TaskPersistenceReceipt;
  childSessionKey: string;
  childSessionId: string;
  announceId: string;
  status: AgentHarnessCompletionStatus;
  statusLabel?: string;
  result: string;
  taskLabel?: string;
  announceType?: string;
  replyInstruction?: string;
  /** Current source owner may admit new delivery work; accepted work keeps its own lifecycle. */
  isSourceSessionAdmissionAllowed?: () => boolean;
  signal?: AbortSignal;
  /** Plugin-owned historical locator can narrow admission, never grant ownership. */
  expectedRequester?: { sessionId: string; lifecycleRevision?: string };
}): Promise<AgentHarnessCompletionDelivery> {
  const scope = assertAgentHarnessTaskRuntimeScope(params.scope);
  const requesterSessionKey = scope.requesterSessionKey;
  const childSessionKey = params.childSessionKey.trim();
  const childSessionId = params.childSessionId.trim();
  const taskLabel = params.taskLabel?.trim() || "Agent harness task";
  const announceType = params.announceType?.trim() || "Agent harness task";
  const statusLabel = params.statusLabel?.trim() || params.status;
  const eventStatus = mapHarnessCompletionStatus(params.status);
  // Capture completion ownership before origin resolution can yield to a new task.
  const readOwnedTasks = () =>
    listTaskRecords(
      (task) =>
        task.runtime === "subagent" &&
        Boolean(task.taskKind) &&
        task.requesterSessionKey === requesterSessionKey &&
        task.runId === childSessionKey,
    );
  const ownedTasks = readOwnedTasks();
  const sourceTask = ownedTasks.length === 1 ? ownedTasks[0] : undefined;
  const taskReceipt =
    params.expectedTask ?? (sourceTask && captureTaskPersistenceReceipt(sourceTask));
  const isTaskCurrent = () => {
    const current = readOwnedTasks();
    if (!taskReceipt) {
      return ownedTasks.length === 0 && current.length === 0;
    }
    const task = current[0];
    return (
      current.length === 1 &&
      task !== undefined &&
      taskReceipt !== undefined &&
      matchesTaskPersistenceReceipt(task, taskReceipt) &&
      task.status === params.status &&
      task.deliveryStatus === "pending"
    );
  };
  const expectedRequester = params.expectedRequester;
  const isRequesterCurrent = () => {
    if (
      params.completionCustody &&
      !isAgentHarnessCompletionCustodyCurrent(params.completionCustody, scope)
    ) {
      return false;
    }
    if (!expectedRequester) {
      return true;
    }
    const current = loadRequesterSessionEntry(requesterSessionKey).entry;
    return (
      current?.sessionId === expectedRequester.sessionId &&
      current.lifecycleRevision === expectedRequester.lifecycleRevision
    );
  };
  const isSourceSessionEffectsAllowed = () =>
    !params.completionCustody?.signal.aborted && isRequesterCurrent() && isTaskCurrent();
  const requesterIsSubagent = isInternalAnnounceRequesterSession(requesterSessionKey);
  let directOrigin = scope.requesterOrigin;
  if (!requesterIsSubagent) {
    const { entry } = loadRequesterSessionEntry(requesterSessionKey);
    directOrigin = resolveAnnounceOrigin(entry, scope.requesterOrigin);
  }
  const completionDirectOrigin =
    requesterIsSubagent || !directOrigin
      ? directOrigin
      : await resolveSubagentCompletionOrigin({
          childSessionKey,
          requesterSessionKey,
          requesterOrigin: directOrigin,
          childRunId: childSessionKey,
          spawnMode: "run",
          expectsCompletionMessage: true,
        });
  const internalEvents: AgentInternalEvent[] = [
    {
      type: AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION,
      source: "subagent",
      childSessionKey,
      childSessionId,
      announceType,
      taskLabel,
      status: eventStatus,
      statusLabel,
      result: params.result,
      replyInstruction:
        params.replyInstruction?.trim() ||
        "Use the completed harness task result to continue or wrap up the parent task. If this is a channel session, send the visible response with the message tool instead of only writing a transcript final answer.",
    },
  ];
  const prompt = formatAgentInternalEventsForPrompt(internalEvents);
  const deliver = async (): Promise<AgentHarnessCompletionDelivery> => {
    if (ownedTasks.length > 1 || readOwnedTasks().length > 1) {
      return {
        delivered: false,
        path: "none",
        recoveryBlocked: true,
        error: "completion task ownership is ambiguous",
      };
    }
    if (!isRequesterCurrent()) {
      return {
        delivered: false,
        path: "none",
        recoveryBlocked: true,
        error: "completion requester locator is missing or replaced",
      };
    }
    const requester = loadRequesterSessionEntry(requesterSessionKey);
    if (requester.agentId && requester.storePath) {
      const custody = reconcileHarnessCompletionDelivery({
        agentId: requester.agentId,
        storePath: requester.storePath,
        sessionKey: requester.canonicalKey,
        sourceRunId: buildAnnounceIdempotencyKey(params.announceId),
        taskRunId: childSessionKey,
      });
      if (custody === "delivered") {
        return { delivered: true, path: "direct" };
      }
      if (custody !== "unowned") {
        return {
          delivered: false,
          path: "none",
          ...(custody === "pending"
            ? { recoveryPending: true as const }
            : { recoveryBlocked: true as const }),
          error:
            custody === "pending"
              ? "completion is owned by requester recovery"
              : "completion recovery receipt or owner is unresolved",
        };
      }
    }
    if (!isTaskCurrent()) {
      return {
        delivered: false,
        path: "none",
        recoveryBlocked: true,
        error: "completion task is no longer owed by this requester",
      };
    }
    return await deliverSubagentAnnouncement({
      requesterSessionKey,
      isSourceSessionEffectsAllowed,
      triggerMessage: prompt,
      steerMessage: prompt,
      internalEvents,
      requesterSessionOrigin: scope.requesterOrigin,
      completionDirectOrigin: completionDirectOrigin ?? directOrigin,
      directOrigin,
      sourceSessionKey: childSessionKey,
      sourceTool: AGENT_HARNESS_COMPLETION_SOURCE_TOOL,
      isSourceSessionAdmissionAllowed: params.isSourceSessionAdmissionAllowed,
      targetRequesterSessionKey: requesterSessionKey,
      requesterIsSubagent,
      expectsCompletionMessage: true,
      bestEffortDeliver: true,
      directIdempotencyKey: buildAnnounceIdempotencyKey(params.announceId),
      signal: params.completionCustody
        ? AbortSignal.any([
            params.completionCustody.signal,
            ...(params.signal ? [params.signal] : []),
          ])
        : params.signal,
    });
  };
  const resolveGatewayContext = getGatewayContextResolver(scope);
  const deliverInGateway = () =>
    resolveGatewayContext
      ? withPluginRuntimeGatewayContextResolver(resolveGatewayContext, deliver)
      : deliver();
  return params.completionCustody
    ? await runWithAgentHarnessCompletionCustody(params.completionCustody, scope, deliverInGateway)
    : await deliverInGateway();
}

function mapHarnessCompletionStatus(
  status: AgentHarnessCompletionStatus,
): AgentInternalEventStatus {
  if (status === "succeeded") {
    return "ok";
  }
  return "error";
}

/** Returns true when completion delivery reached a persistent direct or steered path. */
export function isDurableAgentHarnessCompletionDelivery(
  delivery: AgentHarnessCompletionDelivery,
): boolean {
  if (!delivery.delivered) {
    return false;
  }
  if (delivery.path === "steered") {
    return true;
  }
  if (delivery.path !== "direct") {
    return false;
  }
  const phases = Array.isArray(delivery.phases) ? delivery.phases : undefined;
  if (!phases) {
    return true;
  }
  return phases.some(
    (phase) => phase.phase === "direct-primary" && phase.delivered && phase.path === "direct",
  );
}

function assertScopedRunId(runId: string, runIdPrefix: string | undefined): void {
  const normalized = runId.trim();
  if (!normalized) {
    throw new Error("Agent harness task runtime requires runId");
  }
  if (runIdPrefix && !normalized.startsWith(runIdPrefix)) {
    throw new Error("Agent harness task runId is outside the configured scope");
  }
}
