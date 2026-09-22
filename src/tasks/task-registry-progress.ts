import { createHash } from "node:crypto";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import type { SubagentRunRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
import {
  getAgentRunLifecycleGeneration,
  resolveProjectedAgentRunProgressState,
} from "../infra/agent-run-registry.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../process/gateway-work-admission.js";
import { hasAuthoritativeTaskBacking, readTaskBackingInstance } from "./task-backing-authority.js";
import { getTaskExecutionObservation } from "./task-execution-observation.js";
import { shouldAutoDeliverTaskStateChange } from "./task-executor-policy.js";
import { canDeliverToRequesterOrigin, resolveTaskDeliveryOwner } from "./task-registry-delivery.js";
import { loadTaskRegistryDeliveryRuntime } from "./task-registry-runtime-loaders.js";
import {
  getTasksByRunId,
  tasks,
  taskProgressBatches,
  taskRegistryLog,
  withTaskRegistryMutation,
} from "./task-registry-state.js";
import type { TaskProgressBatch } from "./task-registry.process-state.js";
import type { TaskRecord } from "./task-registry.types.js";
import { formatTaskStatusTitleText, sanitizeTaskStatusText } from "./task-status.js";

const YIELDED_PROGRESS_COALESCE_MS = 15_000;
const MAX_PROGRESS_BATCHES = 128;
const MAX_PROGRESS_BATCH_MEMBERS = 32;
const MAX_PROGRESS_DISPLAY_MEMBERS = 8;

function resolveYieldedTaskProgress(task: TaskRecord, runId: string) {
  if (task.runtime !== "subagent" || !shouldAutoDeliverTaskStateChange(task)) {
    return undefined;
  }
  const backing = readTaskBackingInstance(task.detail);
  const entry = subagentRuns.get(runId);
  const wake = entry?.requesterSettleWake;
  if (
    backing?.runtime !== "subagent" ||
    !entry ||
    entry.generation !== backing.generation ||
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
    (entry.execution.status === "terminal" && entry.pauseReason !== "sessions_yield") ||
    wake?.requesterYieldBatch !== true ||
    wake.status !== "pending" ||
    wake.rearmGeneration === undefined ||
    !wake.batchRunIds?.includes(runId) ||
    !hasAuthoritativeTaskBacking(task)
  ) {
    return undefined;
  }
  const owner = resolveTaskDeliveryOwner(task);
  if (!owner.sessionKey || !canDeliverToRequesterOrigin(owner.requesterOrigin)) {
    return undefined;
  }
  const key = JSON.stringify([
    owner.sessionKey,
    owner.agentId,
    owner.requesterOrigin,
    wake.rearmGeneration,
    wake.batchRunIds,
  ]);
  return { task, entry, owner, key, generation: backing.generation };
}

/** Enqueue only host-observed activity, never private child prose or tool results. */
export function scheduleYieldedSubagentTaskProgress(task: TaskRecord, event: AgentEventPayload) {
  if (event.stream !== "tool" && event.stream !== "approval" && event.stream !== "execution") {
    return;
  }
  enqueueYieldedTaskProgress(task, event.runId);
}

/** The handoff itself may be the last event before a child's long-running tool returns. */
export function scheduleYieldedSubagentRunProgress(entry: SubagentRunRecord) {
  for (const task of getTasksByRunId(entry.taskRunId ?? entry.runId)) {
    enqueueYieldedTaskProgress(task, entry.runId);
  }
}

function enqueueYieldedTaskProgress(task: TaskRecord, runId: string) {
  const progress = resolveYieldedTaskProgress(task, runId);
  if (!progress) {
    return;
  }
  let batch = taskProgressBatches.get(progress.key);
  if (!batch) {
    if (taskProgressBatches.size >= MAX_PROGRESS_BATCHES) {
      taskRegistryLog.warn("Background progress queue is full; activity remains in Tasks");
      return;
    }
    batch = {
      lifecycleGeneration: getAgentRunLifecycleGeneration(),
      members: new Map(),
      revision: 0,
      overflow: false,
    };
    taskProgressBatches.set(progress.key, batch);
  }
  if (batch.members.has(task.taskId) || batch.members.size < MAX_PROGRESS_BATCH_MEMBERS) {
    batch.members.set(task.taskId, { runId, generation: progress.generation });
  } else {
    batch.overflow = true;
  }
  batch.revision += 1;
  scheduleProgressBatch(progress.key, batch);
}

function scheduleProgressBatch(key: string, batch: TaskProgressBatch) {
  if (batch.timer || batch.publishing) {
    return;
  }
  batch.timer = setTimeout(() => {
    batch.timer = undefined;
    void publishProgressBatch(key, batch);
  }, YIELDED_PROGRESS_COALESCE_MS);
  batch.timer.unref?.();
}

function prepareProgressBatch(key: string, batch: TaskProgressBatch) {
  if (
    taskProgressBatches.get(key) !== batch ||
    batch.lifecycleGeneration !== getAgentRunLifecycleGeneration()
  ) {
    return undefined;
  }
  const rows = [...batch.members.entries()]
    .flatMap(([taskId, member]) => {
      const current = tasks.get(taskId);
      const row = current ? resolveYieldedTaskProgress(current, member.runId) : undefined;
      return row?.key === key && row.generation === member.generation ? [row] : [];
    })
    .toSorted(
      (left, right) =>
        left.task.createdAt - right.task.createdAt ||
        left.task.taskId.localeCompare(right.task.taskId),
    );
  const owner = rows[0]?.owner;
  if (
    !owner?.sessionKey ||
    resolveProjectedAgentRunProgressState({
      sessionKeys: [owner.sessionKey],
      agentId: owner.agentId,
    })
  ) {
    return undefined;
  }
  const lines = rows.slice(0, MAX_PROGRESS_DISPLAY_MEMBERS).map(({ task }) => {
    const observation = getTaskExecutionObservation(task);
    const currentTool = sanitizeTaskStatusText(observation.currentTool?.name, { maxChars: 60 });
    const state =
      observation?.state === "waiting"
        ? observation.wait?.kind === "children"
          ? `waiting for ${observation.wait.pendingCount} child tasks`
          : observation.wait?.kind === "approval"
            ? "waiting for approval"
            : observation.wait?.kind === "user_input"
              ? "waiting for input"
              : observation.wait?.kind === "agent_messages"
                ? "waiting for agent messages"
                : "waiting for external work"
        : observation.state === "unknown"
          ? "current activity unavailable"
          : currentTool
            ? `running ${currentTool}`
            : observation?.state === "queued"
              ? "queued"
              : "working";
    const calls = task.toolUseCount
      ? `; ${task.toolUseCount} tool ${task.toolUseCount === 1 ? "call" : "calls"} started`
      : "";
    return `- ${formatTaskStatusTitleText(task.label, "Subagent task")}: ${state}${calls}.`;
  });
  if (rows.length > MAX_PROGRESS_DISPLAY_MEMBERS || batch.overflow) {
    lines.push("- More task activity is available in Tasks.");
  }
  return {
    owner,
    membersKey: JSON.stringify(
      rows.map(({ task, entry }) => [task.taskId, entry.runId, entry.generation]),
    ),
    content: `Background work is still in progress:\n${lines.join("\n")}`,
  };
}

async function publishProgressBatch(key: string, batch: TaskProgressBatch) {
  batch.publishing = true;
  const revision = batch.revision;
  try {
    await runWithGatewayIndependentRootWorkContinuation(async () => {
      if (!prepareProgressBatch(key, batch)) {
        return null;
      }
      const { sendMessage } = await loadTaskRegistryDeliveryRuntime();
      const fresh = withTaskRegistryMutation(
        () => prepareProgressBatch(key, batch),
        () => undefined,
      );
      if (!fresh) {
        return null;
      }
      const assertCurrent = () => {
        const current = prepareProgressBatch(key, batch);
        if (!current || current.membersKey !== fresh.membersKey) {
          throw new Error("Background progress was superseded before delivery");
        }
      };
      const idempotencyKey = `task-progress:${createHash("sha256").update(key).digest("hex")}:${Date.now()}`;
      await sendMessage({
        channel: fresh.owner.requesterOrigin?.channel,
        to: fresh.owner.requesterOrigin?.to ?? "",
        accountId: fresh.owner.requesterOrigin?.accountId,
        threadId: fresh.owner.requesterOrigin?.threadId,
        content: fresh.content,
        agentId: fresh.owner.agentId,
        idempotencyKey,
        mirror: {
          sessionKey: fresh.owner.sessionKey!,
          agentId: fresh.owner.agentId,
          idempotencyKey,
        },
        skipQueue: true,
        gatewayOwnedDelivery: true,
        assertDirectAdapterHandoff: assertCurrent,
        onPlatformSendDispatch: async () => assertCurrent(),
      });
      return null;
    }, "tasks:progress");
  } catch (error) {
    taskRegistryLog.debug("Background progress was not delivered; task completion is unaffected", {
      error,
    });
  } finally {
    batch.publishing = false;
    if (taskProgressBatches.get(key) === batch) {
      if (batch.revision !== revision) {
        scheduleProgressBatch(key, batch);
      } else {
        taskProgressBatches.delete(key);
      }
    }
  }
}
