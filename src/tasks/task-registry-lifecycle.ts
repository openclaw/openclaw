import { buildAgentRunTerminalOutcomeFromLifecycleEvent } from "../agents/agent-run-terminal-outcome.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { onSubagentRegistryPersisted } from "../agents/subagents/registry/subagent-registry-state.js";
import {
  onAgentEvent,
  registerAgentEventLifecycleRotationHandler,
  type AgentEventPayload,
} from "../infra/agent-events.js";
import { onSessionIdentityMutation } from "../sessions/session-lifecycle-events.js";
import { hasAuthoritativeTaskBacking, readTaskBackingInstance } from "./task-backing-authority.js";
import { recordTaskActivityEvent } from "./task-registry-activity.js";
import {
  appendTaskEvent,
  mapAgentRunTerminalOutcomeToTaskStatus,
  resolveTaskLifecycleTerminalError,
} from "./task-registry-common.js";
import {
  maybeDeliverTaskStateChangeUpdate,
  maybeDeliverTaskTerminalUpdate,
} from "./task-registry-delivery.js";
import { updateTask } from "./task-registry-mutation.js";
import {
  reconcileTaskProgressBatches,
  retireTaskProgressForSession,
  scheduleYieldedSubagentTaskProgress,
} from "./task-registry-progress.js";
import {
  withTaskRegistryMutation,
  claimTaskRegistryListenerStart,
  getTasksByRunScope,
  ensureTaskRegistryReady,
  setTaskRegistryListenerStarter,
  setTaskRegistryListenerStop,
} from "./task-registry-state.js";
import { clearTaskProgressBatches } from "./task-registry.process-state.js";
import { onTaskRegistryChange } from "./task-registry.store.js";
import { isTerminalTaskStatus, type TaskRecord } from "./task-registry.types.js";
import { getTaskRunOwner } from "./task-run-owner.js";

// Keep durable liveness well inside the 30-minute stale-task audit without writing every delta.
const ACTIVITY_LIVENESS_WRITE_MS = 60_000;

function selectEventTasks(evt: AgentEventPayload): TaskRecord[] {
  const scopedTasks = getTasksByRunScope({
    runId: evt.runId,
    sessionKey: evt.sessionKey,
  });
  const subagent = subagentRuns.get(evt.runId);
  const canonicalRunId = subagent?.taskRunId;
  // Replacement runs retain the original task identity. Follow the live
  // registry owner without changing event routing for other task runtimes.
  if (canonicalRunId && canonicalRunId !== evt.runId) {
    scopedTasks.push(
      ...getTasksByRunScope({
        runId: canonicalRunId,
        runtime: "subagent",
        sessionKey: evt.sessionKey,
      }).filter((task) => readTaskBackingInstance(task.detail)?.runtime === "subagent"),
    );
  }
  return scopedTasks;
}

function ensureListener() {
  if (!claimTaskRegistryListenerStart()) {
    return;
  }
  const stop = onAgentEvent((evt) => {
    ensureTaskRegistryReady();
    if (evt.stream === "lifecycle" && evt.data.phase === "start") {
      reconcileTaskProgressBatches();
    }
    const scopedTasks = selectEventTasks(evt);
    if (scopedTasks.length === 0) {
      return;
    }
    const now = evt.ts || Date.now();
    const observe = (currentTasks: TaskRecord[]) => {
      const subagent = subagentRuns.get(evt.runId);
      for (const current of currentTasks) {
        const backing = readTaskBackingInstance(current.detail);
        const registryBackedSubagent =
          current.runtime === "subagent" && backing?.runtime === "subagent";
        if (
          isTerminalTaskStatus(current.status) ||
          !hasAuthoritativeTaskBacking(current) ||
          (registryBackedSubagent &&
            (subagent?.generation !== backing.generation ||
              subagent?.childSessionKey !== current.childSessionKey))
        ) {
          continue;
        }
        const phase = evt.stream === "lifecycle" ? evt.data?.phase : undefined;
        const prepared = recordTaskActivityEvent(current, evt);
        scheduleYieldedSubagentTaskProgress(current, evt, prepared);
        // An abort event starts cancellation; only the live producer knows when work has settled.
        if ((phase === "end" || phase === "error") && getTaskRunOwner(current)) {
          continue;
        }
        const patch: Partial<TaskRecord> = {};
        if (evt.stream === "lifecycle") {
          const eventStartedAt = evt.data?.startedAt;
          const startedAt =
            typeof eventStartedAt === "number" && Number.isFinite(eventStartedAt)
              ? eventStartedAt
              : current.startedAt;
          const endedAt = typeof evt.data?.endedAt === "number" ? evt.data.endedAt : undefined;
          if (startedAt !== undefined) {
            patch.startedAt = startedAt;
          }
          if (phase === "start") {
            patch.status = "running";
          } else if (phase === "end" || phase === "error") {
            // Registry-backed subagents keep task.runId across replacement runs.
            // Their registry owns terminal projection; predecessor events do not.
            if (registryBackedSubagent) {
              continue;
            }
            const terminal = buildAgentRunTerminalOutcomeFromLifecycleEvent({
              phase,
              data: evt.data,
              startedAt,
              endedAt: endedAt ?? now,
            });
            patch.status = mapAgentRunTerminalOutcomeToTaskStatus(terminal);
            patch.endedAt = terminal.endedAt ?? now;
            const error = resolveTaskLifecycleTerminalError({
              runtime: current.runtime,
              status: patch.status,
              terminalReason: terminal.reason,
              error: terminal.error,
            });
            if (error || phase === "error") {
              patch.error = error ?? current.error;
            }
          }
        } else if (evt.stream === "error") {
          patch.error = typeof evt.data?.error === "string" ? evt.data.error : current.error;
        } else if (evt.stream === "tool" && evt.data?.phase === "start") {
          // Tool starts are the activity signal surfaced in task summaries; ends
          // and outputs only refresh lastEventAt.
          const toolName = typeof evt.data.name === "string" ? evt.data.name.trim() : "";
          if (toolName) {
            patch.toolUseCount = (current.toolUseCount ?? 0) + 1;
            patch.lastToolName = toolName;
          }
        }
        const lastEventAt = current.lastEventAt ?? current.startedAt ?? current.createdAt;
        if (Object.keys(patch).length === 0 && now - lastEventAt < ACTIVITY_LIVENESS_WRITE_MS) {
          continue;
        }
        patch.lastEventAt = now;
        const stateChangeEvent =
          patch.status && patch.status !== current.status
            ? appendTaskEvent({
                at: now,
                kind: patch.status,
                summary:
                  patch.status === "failed"
                    ? (patch.error ?? current.error)
                    : patch.status === "succeeded"
                      ? current.terminalSummary
                      : undefined,
              })
            : undefined;
        const updated = updateTask(current.taskId, patch);
        if (updated) {
          void maybeDeliverTaskStateChangeUpdate(current.taskId, stateChangeEvent);
          void maybeDeliverTaskTerminalUpdate(current.taskId);
        }
      }
    };
    const needsPersistence =
      evt.stream === "lifecycle" ||
      evt.stream === "error" ||
      (evt.stream === "tool" && evt.data?.phase === "start") ||
      scopedTasks.some(
        (task) =>
          now - (task.lastEventAt ?? task.startedAt ?? task.createdAt) >=
          ACTIVITY_LIVENESS_WRITE_MS,
      );
    if (needsPersistence) {
      // Refresh and reselect under custody before any durable change or delivery.
      withTaskRegistryMutation(() => observe(selectEventTasks(evt)));
    } else {
      // Streaming overlays and progress batching already coalesce in memory.
      observe(scopedTasks);
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
