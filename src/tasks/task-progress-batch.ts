import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { getLatestLiveSubagentRunByChildSessionKey } from "../agents/subagents/registry/subagent-registry-read.js";
import {
  getAgentRunLifecycleGeneration,
  resolveProjectedAgentRunProgressState,
} from "../infra/agent-run-registry.js";
import { isGatewayRestartDraining } from "../process/gateway-work-admission.js";
import { readTaskBackingInstance, type TaskBackingRead } from "./task-backing-authority.js";
import { shouldAutoDeliverTaskStateChange } from "./task-notification-policy.js";
import {
  canDeliverToRequesterOrigin,
  resolveTaskDeliveryOwner,
} from "./task-notification-routing.js";
import { taskProgressBatches } from "./task-registry-state.js";
import type { TaskProgressBatch, TaskProgressMember } from "./task-registry.process-state.js";
import { isTerminalTaskStatus, type TaskRecord } from "./task-registry.types.js";

export type ProgressRead = Pick<
  TaskBackingRead,
  "getTaskById" | "getTaskFlowById" | "hasAuthoritativeTaskBacking"
>;
export function resolveYieldedTaskProgress(
  task: TaskRecord,
  runId: string,
  hasBacking: ProgressRead["hasAuthoritativeTaskBacking"],
  readFlow: ProgressRead["getTaskFlowById"],
) {
  if (task.runtime !== "subagent" || task.notifyPolicy === "silent") {
    return undefined;
  }
  const backing = readTaskBackingInstance(task.detail);
  const entry = subagentRuns.get(runId);
  const wake = entry?.requesterSettleWake;
  const operationId = wake?.progressOperationId;
  if (
    backing?.runtime !== "subagent" ||
    !entry ||
    entry.generation !== backing.generation ||
    (operationId && !entry.completionRequesterSessionId) ||
    (entry.taskRunId ?? entry.runId) !== task.runId ||
    entry.childSessionKey !== task.childSessionKey ||
    entry.requesterSessionKey !== task.ownerKey ||
    (entry.requesterAgentId !== undefined && entry.requesterAgentId !== task.requesterAgentId) ||
    entry.killIntent ||
    entry.killReconciliation ||
    entry.execution.suppressSessionEffects ||
    entry.suppressAnnounceReason ||
    entry.requesterTurnRunId ||
    entry.collect === true ||
    wake?.requesterYieldBatch !== true ||
    (wake.status !== "pending" && wake.status !== "dispatching") ||
    (!operationId &&
      (!shouldAutoDeliverTaskStateChange(task) ||
        wake.status !== "pending" ||
        (entry.execution.status === "terminal" && entry.pauseReason !== "sessions_yield"))) ||
    wake.rearmGeneration === undefined ||
    !wake.batchRunIds?.includes(runId) ||
    !hasBacking(task)
  ) {
    return undefined;
  }
  const owner = resolveTaskDeliveryOwner(task, readFlow);
  if (
    !owner.sessionKey ||
    (operationId && !owner.agentId) ||
    !canDeliverToRequesterOrigin(owner.requesterOrigin)
  ) {
    return undefined;
  }
  const key = JSON.stringify([
    owner.sessionKey,
    owner.agentId,
    owner.requesterOrigin,
    ...(operationId ? [operationId] : [wake.rearmGeneration, wake.batchRunIds]),
  ]);
  return {
    task,
    entry,
    owner,
    key,
    generation: backing.generation,
    operationId,
    requesterSessionId: entry.completionRequesterSessionId,
  };
}

export function prepareProgressBatch(key: string, batch: TaskProgressBatch, read: ProgressRead) {
  if (
    taskProgressBatches.get(key) !== batch ||
    batch.abortController.signal.aborted ||
    isGatewayRestartDraining() ||
    batch.lifecycleGeneration !== getAgentRunLifecycleGeneration() ||
    (!batch.operationId &&
      resolveProjectedAgentRunProgressState({
        sessionKeys: [batch.requesterSessionKey],
        agentId: batch.requesterAgentId,
      }))
  ) {
    return undefined;
  }
  const rows: Array<{ task: TaskRecord; entry: TaskProgressMember }> = [];
  let awaitingTerminal = false;
  let hasPendingWake = false;
  for (const [taskId, member] of batch.members) {
    const task = read.getTaskById(taskId);
    const backing = task ? readTaskBackingInstance(task.detail) : undefined;
    if (
      !task ||
      task.runtime !== "subagent" ||
      task.notifyPolicy === "silent" ||
      task.runId !== member.taskRunId ||
      task.ownerKey !== batch.requesterSessionKey ||
      backing?.runtime !== "subagent" ||
      backing.generation !== member.generation ||
      task.childSessionKey !== member.childSessionKey
    ) {
      continue;
    }
    const owner = resolveTaskDeliveryOwner(task, read.getTaskFlowById);
    if (
      owner.agentId !== batch.requesterAgentId ||
      (owner.requesterOrigin &&
        JSON.stringify(owner.requesterOrigin) !== JSON.stringify(batch.origin))
    ) {
      continue;
    }
    const latest = getLatestLiveSubagentRunByChildSessionKey(member.childSessionKey);
    if (
      latest &&
      (latest.taskRunId ?? latest.runId) === task.runId &&
      (latest.runId !== member.runId || latest.generation !== member.generation)
    ) {
      continue;
    }
    const entry = subagentRuns.get(member.runId);
    if (
      entry &&
      (entry.generation !== member.generation ||
        entry.requesterSessionKey !== batch.requesterSessionKey ||
        entry.completionRequesterSessionId !== batch.requesterSessionId ||
        entry.collect ||
        (entry.requesterSettleWake?.progressOperationId &&
          entry.requesterSettleWake.progressOperationId !== batch.operationId))
    ) {
      continue;
    }
    const active = resolveYieldedTaskProgress(
      task,
      member.runId,
      read.hasAuthoritativeTaskBacking,
      read.getTaskFlowById,
    );
    if (active?.key === key) {
      hasPendingWake = true;
      rows.push({ task, entry: member });
    } else if (batch.operationId && isTerminalTaskStatus(task.status)) {
      const wake = entry?.requesterSettleWake;
      hasPendingWake ||=
        wake?.progressOperationId === batch.operationId &&
        wake.batchRunIds?.includes(member.runId) === true;
      rows.push({ task, entry: member });
    } else if (batch.operationId && (entry?.killIntent || entry?.killReconciliation)) {
      awaitingTerminal = true;
    }
  }
  if (rows.length === 0 && !awaitingTerminal) {
    return undefined;
  }
  rows.sort(
    (left, right) =>
      left.task.createdAt - right.task.createdAt ||
      left.task.taskId.localeCompare(right.task.taskId),
  );
  return {
    owner: {
      sessionKey: batch.requesterSessionKey,
      agentId: batch.requesterAgentId,
      requesterOrigin: batch.origin,
    },
    origin: batch.origin,
    sessionKey: batch.requesterSessionKey,
    rows,
    complete:
      Boolean(batch.operationId) &&
      !awaitingTerminal &&
      !hasPendingWake &&
      !batch.requesterContinuation?.isCurrent() &&
      rows.every(({ task }) => isTerminalTaskStatus(task.status)),
    membersKey: JSON.stringify(
      rows.map(({ task, entry }) => [task.taskId, task.status, entry.runId, entry.generation]),
    ),
  };
}
