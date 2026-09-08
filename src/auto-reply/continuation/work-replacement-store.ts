import type { TaskFlowRecord } from "../../tasks/task-flow-registry.types.js";
import type { TaskFlowAtomicUpdate } from "../../tasks/task-flow-runtime-internal.js";
import {
  createManagedTaskFlowWithAtomicUpdates,
  getTaskFlowById,
  listTaskFlowsForOwnerKey,
  requestFlowCancel,
  updateTaskFlowsAtomically,
} from "../../tasks/task-flow-runtime-internal.js";
import { abortContinuationDispatchClaim } from "./continuation-dispatch-claims.js";
import type { ContinuationWorkReplacementFailure } from "./types.js";
import {
  CONTINUATION_WORK_CONTROLLER_ID,
  decodeWorkState,
  encodeWorkState,
  isContinuationWorkFlow,
  workGoal,
  workToRuntime,
  type PendingContinuationWork,
  type PendingWorkState,
} from "./work-flow-state.js";

export function buildFinishedWorkPatch(
  state: PendingWorkState,
  params: { currentStep: string; stateExtra?: Record<string, unknown>; now: number },
): TaskFlowAtomicUpdate["patch"] {
  const { idleRetry: _idleRetry, recoveryDueAt: _recoveryDueAt, ...terminalState } = state;
  return {
    status: "succeeded",
    currentStep: params.currentStep,
    stateJson: {
      ...terminalState,
      turnGrantedAt: params.now,
      ...params.stateExtra,
    },
    waitJson: null,
    blockedTaskId: null,
    blockedSummary: null,
    endedAt: params.now,
    updatedAt: params.now,
  };
}

export type PendingWorkReplacementResult =
  | {
      applied: true;
      work: PendingContinuationWork;
      supersededFlows: readonly TaskFlowRecord[];
    }
  | { applied: false; capped: true }
  | {
      applied: false;
      capped: false;
      reason: ContinuationWorkReplacementFailure;
      flowId?: string;
    };

export function listQueuedTurnEndParkedWork(sessionKey: string): TaskFlowRecord[] {
  return listTaskFlowsForOwnerKey(sessionKey).filter((flow) => {
    const state = isContinuationWorkFlow(flow) ? decodeWorkState(flow) : undefined;
    return (
      flow.status === "queued" &&
      flow.cancelRequestedAt == null &&
      state?.idleRetry?.trigger === "reply-run-ended"
    );
  });
}

export function listRunningContinuationWorkIds(sessionKey: string): string[] {
  return listTaskFlowsForOwnerKey(sessionKey)
    .filter(
      (flow) =>
        isContinuationWorkFlow(flow) && flow.status === "running" && flow.cancelRequestedAt == null,
    )
    .map((flow) => flow.flowId);
}

export function enqueuePendingWorkReplacing(params: {
  work: PendingContinuationWork;
  summary: string;
  maxPendingWork: number;
  replaceParkedWork: boolean;
  expectedPriorFlowIds: readonly string[];
  expectedRunningFlowIds: readonly string[];
}): PendingWorkReplacementResult {
  const state = encodeWorkState(params.work);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const ownerFlows = listTaskFlowsForOwnerKey(params.work.sessionKey).filter((flow) => {
      if (!isContinuationWorkFlow(flow) || flow.cancelRequestedAt != null) {
        return false;
      }
      return flow.status === "queued" || flow.status === "running";
    });
    const expectedRunningFlowIds = new Set(params.expectedRunningFlowIds);
    if (
      params.replaceParkedWork &&
      ownerFlows.some(
        (flow) => flow.status === "running" && !expectedRunningFlowIds.has(flow.flowId),
      )
    ) {
      return { applied: false, capped: false, reason: "running_owner" };
    }
    const queuedFlows = ownerFlows.filter((flow) => flow.status === "queued");
    const priorFlows = params.replaceParkedWork
      ? queuedFlows.filter(
          (flow) => decodeWorkState(flow)?.idleRetry?.trigger === "reply-run-ended",
        )
      : [];
    const priorFlowIds = new Set(priorFlows.map((flow) => flow.flowId));
    if (
      queuedFlows.filter((flow) => !priorFlowIds.has(flow.flowId)).length >= params.maxPendingWork
    ) {
      return { applied: false, capped: true };
    }
    const now = Date.now();
    const updates: TaskFlowAtomicUpdate[] = [];
    for (const prior of priorFlows) {
      const priorState = decodeWorkState(prior);
      if (
        !isContinuationWorkFlow(prior) ||
        prior.status !== "queued" ||
        priorState?.idleRetry?.trigger !== "reply-run-ended"
      ) {
        return { applied: false, capped: false, reason: "invalid_prior", flowId: prior.flowId };
      }
      updates.push({
        flowId: prior.flowId,
        expectedRevision: prior.revision,
        patch: buildFinishedWorkPatch(priorState, {
          currentStep: `superseded: ${params.summary}`.slice(0, 200),
          now,
        }),
      });
    }
    const result = createManagedTaskFlowWithAtomicUpdates({
      create: {
        ownerKey: params.work.sessionKey,
        ...(params.work.chainId ? { chainId: params.work.chainId } : {}),
        controllerId: CONTINUATION_WORK_CONTROLLER_ID,
        notifyPolicy: "silent",
        goal: workGoal(params.work),
        currentStep: "Queued for same-session continuation wake",
        stateJson: state,
        createdAt: params.work.electedAt,
      },
      updates,
      ownerCondition: {
        ownerKey: params.work.sessionKey,
        controllerId: CONTINUATION_WORK_CONTROLLER_ID,
        statuses: ["queued", "running"],
        expectedFlows: ownerFlows.map((flow) => ({
          flowId: flow.flowId,
          revision: flow.revision,
          status: flow.status,
        })),
        excludeCancelRequested: true,
      },
    });
    if (result.applied) {
      return {
        applied: true,
        work: workToRuntime(result.created, state, "queued"),
        supersededFlows: priorFlows,
      };
    }
    if (attempt === 0 && (result.reason === "not_found" || result.reason === "revision_conflict")) {
      continue;
    }
    return {
      applied: false,
      capped: false,
      reason: result.reason,
      ...(result.flowId ? { flowId: result.flowId } : {}),
    };
  }
  return { applied: false, capped: false, reason: "revision_conflict" };
}

export type PendingWorkReplacementRollbackResult = {
  applied: boolean;
  unresolvedCreatedFlowIds: string[];
  unrestoredPriorFlowIds: string[];
};

function listUnresolvedCreatedFlowIds(flowIds: readonly string[]): string[] {
  return flowIds.filter((flowId) => {
    const flow = getTaskFlowById(flowId);
    if (
      !flow ||
      flow.status === "failed" ||
      flow.status === "cancelled" ||
      flow.status === "lost"
    ) {
      return false;
    }
    return flow.status === "running" || flow.cancelRequestedAt == null;
  });
}

function listUnrestoredPriorFlowIds(priorFlows: readonly TaskFlowRecord[]): string[] {
  return priorFlows
    .filter((prior) => getTaskFlowById(prior.flowId)?.status !== "queued")
    .map((prior) => prior.flowId);
}

function isExactRestoredPrior(flow: TaskFlowRecord, prior: TaskFlowRecord): boolean {
  return (
    flow.status === "queued" &&
    flow.revision === prior.revision + 2 &&
    flow.currentStep === prior.currentStep &&
    JSON.stringify(flow.stateJson) === JSON.stringify(prior.stateJson) &&
    flow.cancelRequestedAt === prior.cancelRequestedAt &&
    flow.endedAt === undefined
  );
}

function requestCancelForUnresolvedActiveFlows(flowIds: readonly string[]): void {
  for (const flowId of flowIds) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const flow = getTaskFlowById(flowId);
      if (
        !flow ||
        (flow.status !== "queued" && flow.status !== "running") ||
        flow.cancelRequestedAt != null
      ) {
        break;
      }
      if (flow.status === "running") {
        abortContinuationDispatchClaim({
          sessionKey: flow.ownerKey,
          flowId,
          reason: "continuation replacement cancellation retry",
        });
      }
      const cancelled = requestFlowCancel({
        flowId,
        expectedRevision: flow.revision,
      });
      if (cancelled.applied) {
        break;
      }
    }
    const latest = getTaskFlowById(flowId);
    if (latest?.status === "running") {
      abortContinuationDispatchClaim({
        sessionKey: latest.ownerKey,
        flowId,
        reason: "continuation replacement cancellation verification",
      });
    }
  }
}

export function rollbackPendingWorkReplacement(params: {
  sessionKey: string;
  createdFlowIds: readonly string[];
  priorFlows: readonly TaskFlowRecord[];
  originRunId?: string;
  originTurnId?: string;
  summary: string;
}): PendingWorkReplacementRollbackResult {
  let lastUnresolvedCreatedFlowIds: string[] = [];
  let lastUnrestoredPriorFlowIds: string[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const updates: TaskFlowAtomicUpdate[] = [];
    const unresolvedCreatedFlowIds: string[] = [];
    const unrestoredPriorFlowIds: string[] = [];
    let unsafeCreatedOwner = false;
    const now = Date.now();

    for (const flowId of params.createdFlowIds) {
      const flow = getTaskFlowById(flowId);
      if (
        !flow ||
        flow.status === "failed" ||
        flow.status === "cancelled" ||
        flow.status === "lost"
      ) {
        continue;
      }
      const state = isContinuationWorkFlow(flow) ? decodeWorkState(flow) : undefined;
      if (
        !state ||
        state.originRunId !== params.originRunId ||
        state.originTurnId !== params.originTurnId ||
        flow.status === "succeeded"
      ) {
        unsafeCreatedOwner = true;
        unresolvedCreatedFlowIds.push(flowId);
        continue;
      }
      if (flow.status !== "queued" && flow.status !== "running") {
        unsafeCreatedOwner = true;
        unresolvedCreatedFlowIds.push(flowId);
        continue;
      }
      if (flow.status === "running") {
        abortContinuationDispatchClaim({
          sessionKey: params.sessionKey,
          flowId,
          reason: params.summary,
        });
        unsafeCreatedOwner = true;
        unresolvedCreatedFlowIds.push(flowId);
        continue;
      }
      updates.push({
        flowId,
        expectedRevision: flow.revision,
        patch: {
          status: "failed",
          currentStep: "spawn-init continuation finalization failed",
          stateJson: flow.stateJson,
          waitJson: null,
          blockedTaskId: null,
          blockedSummary: params.summary,
          endedAt: now,
          updatedAt: now,
        },
      });
    }

    if (unsafeCreatedOwner) {
      updateTaskFlowsAtomically(updates);
      const unresolved = listUnresolvedCreatedFlowIds(params.createdFlowIds);
      requestCancelForUnresolvedActiveFlows(unresolved);
      return {
        applied: false,
        unresolvedCreatedFlowIds: listUnresolvedCreatedFlowIds(params.createdFlowIds),
        unrestoredPriorFlowIds: listUnrestoredPriorFlowIds(params.priorFlows),
      };
    }

    for (const prior of params.priorFlows) {
      const flow = getTaskFlowById(prior.flowId);
      if (flow && isExactRestoredPrior(flow, prior)) {
        continue;
      }
      if (
        !flow ||
        !isContinuationWorkFlow(flow) ||
        flow.status !== "succeeded" ||
        flow.revision !== prior.revision + 1
      ) {
        unrestoredPriorFlowIds.push(prior.flowId);
        continue;
      }
      updates.push({
        flowId: flow.flowId,
        expectedRevision: flow.revision,
        patch: {
          status: "queued",
          currentStep: prior.currentStep,
          stateJson: prior.stateJson,
          waitJson: null,
          blockedTaskId: null,
          blockedSummary: null,
          cancelRequestedAt: prior.cancelRequestedAt ?? null,
          endedAt: null,
          updatedAt: now,
        },
      });
    }

    const result = updateTaskFlowsAtomically(updates);
    if (result.applied) {
      return {
        applied: true,
        unresolvedCreatedFlowIds,
        unrestoredPriorFlowIds,
      };
    }
    lastUnresolvedCreatedFlowIds = listUnresolvedCreatedFlowIds(params.createdFlowIds);
    lastUnrestoredPriorFlowIds = listUnrestoredPriorFlowIds(params.priorFlows);
  }
  requestCancelForUnresolvedActiveFlows(lastUnresolvedCreatedFlowIds);
  return {
    applied: false,
    unresolvedCreatedFlowIds: listUnresolvedCreatedFlowIds(params.createdFlowIds),
    unrestoredPriorFlowIds: lastUnrestoredPriorFlowIds,
  };
}
