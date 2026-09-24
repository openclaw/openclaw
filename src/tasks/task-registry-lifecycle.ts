import { isDeepStrictEqual } from "node:util";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { onSubagentRegistryPersisted } from "../agents/subagents/registry/subagent-registry-state.js";
import {
  onAgentEvent,
  registerAgentEventLifecycleRotationHandler,
  type AgentEventPayload,
} from "../infra/agent-events.js";
import { onSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { hasResidentTaskBacking, readTaskBackingInstance } from "./task-backing-authority.js";
import { recordTaskActivityEvent } from "./task-registry-activity.js";
import {
  captureTaskAgentEventTarget,
  type TaskAgentEventTarget,
} from "./task-registry-agent-event-target.js";
import { enqueueTaskAgentEvent, taskAgentEventMutations } from "./task-registry-agent-events.js";
import {
  claimTaskRegistryListenerStart,
  setTaskRegistryListenerStarter,
  setTaskRegistryListenerStop,
} from "./task-registry-listener-state.js";
import {
  reconcileTaskProgressBatches,
  retireTaskProgressForSession,
  scheduleYieldedSubagentTaskProgress,
} from "./task-registry-progress.js";
import { filterTasksByRunScope, matchesTaskPersistenceReceipt } from "./task-registry-records.js";
import { getTasksByRunScope, tasks } from "./task-registry-state.js";
import {
  clearTaskProgressBatches,
  getTaskRegistryProcessState,
} from "./task-registry.process-state.js";
import { onTaskRegistryChange } from "./task-registry.store.js";
import { isTerminalTaskStatus, type TaskRecord } from "./task-registry.types.js";

type TaskEventSelection = TaskAgentEventTarget & { record?: TaskRecord };

function selectEventTargets(evt: AgentEventPayload): TaskEventSelection[] {
  const candidates = getTasksByRunScope({ runId: evt.runId, sessionKey: evt.sessionKey });
  const canonicalRunId = subagentRuns.get(evt.runId)?.taskRunId;
  if (canonicalRunId && canonicalRunId !== evt.runId) {
    candidates.push(
      ...getTasksByRunScope({
        runId: canonicalRunId,
        runtime: "subagent",
        sessionKey: evt.sessionKey,
      }).filter((task) => readTaskBackingInstance(task.detail)?.runtime === "subagent"),
    );
  }
  const selected = new Map<string, TaskEventSelection>(
    candidates.map((record) => [record.taskId, { ...captureTaskAgentEventTarget(record), record }]),
  );
  for (const pending of getTaskRegistryProcessState().projection.pending) {
    const physicalRun = pending.scope.runId === evt.runId;
    if (!physicalRun && (!canonicalRunId || pending.scope.runId !== canonicalRunId)) {
      continue;
    }
    if (pending.readEventTarget) {
      const committed = pending.readEventTarget();
      if (
        !committed ||
        (!physicalRun &&
          (committed.runtime !== "subagent" || committed.backing?.runtime !== "subagent")) ||
        !filterTasksByRunScope([committed], { sessionKey: evt.sessionKey }).length
      ) {
        continue;
      }
      const record = tasks.get(committed.taskId);
      selected.set(committed.taskId, {
        ...committed,
        ...(record &&
        matchesTaskPersistenceReceipt(record, committed) &&
        isDeepStrictEqual(readTaskBackingInstance(record.detail), committed.backing)
          ? { record }
          : {}),
      });
      continue;
    }
    if (!physicalRun) {
      continue;
    }
    // Existing rebinds can precede projection, but never invent a newly created row.
    const current = tasks.get(pending.scope.taskId);
    if (current && !selected.has(current.taskId)) {
      const rebound = {
        ...current,
        runId: pending.scope.runId,
        childSessionKey: pending.scope.childSessionKey ?? current.childSessionKey,
      };
      if (filterTasksByRunScope([rebound], { sessionKey: evt.sessionKey }).length) {
        selected.set(current.taskId, {
          ...captureTaskAgentEventTarget(rebound),
          record: rebound,
        });
      }
    }
  }
  return [...selected.values()];
}

function ensureListener() {
  if (!claimTaskRegistryListenerStart(taskAgentEventMutations)) {
    return;
  }
  const stop = onAgentEvent((event) => {
    if (event.stream === "lifecycle" && event.data.phase === "start") {
      reconcileTaskProgressBatches();
    }
    for (const task of selectEventTargets(event)) {
      const backing = task.backing;
      const subagent = subagentRuns.get(event.runId);
      if (
        isTerminalTaskStatus(task.status) ||
        (task.record && !hasResidentTaskBacking(task.record)) ||
        (task.runtime === "subagent" &&
          backing?.runtime === "subagent" &&
          (subagent?.generation !== backing.generation ||
            subagent?.childSessionKey !== task.childSessionKey))
      ) {
        continue;
      }
      if (enqueueTaskAgentEvent(task, event) && task.record) {
        const prepared = recordTaskActivityEvent(task.record, event);
        scheduleYieldedSubagentTaskProgress(task.record, event, prepared);
      }
    }
  });
  const stopTasks = onTaskRegistryChange(reconcileTaskProgressBatches);
  const stopRuns = onSubagentRegistryPersisted(() => reconcileTaskProgressBatches());
  const stopIdentity = onSessionIdentityMutation(retireTaskProgressForSession);
  setTaskRegistryListenerStop(() => {
    stop();
    stopTasks();
    stopRuns();
    stopIdentity();
  });
  // Initial task restoration can publish before these listeners attach.
  reconcileTaskProgressBatches({ kind: "restored" });
}

setTaskRegistryListenerStarter(ensureListener);
registerAgentEventLifecycleRotationHandler("tasks:progress", clearTaskProgressBatches);
