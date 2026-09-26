import { isDeepStrictEqual } from "node:util";
import type { AgentEventPayload } from "../infra/agent-events.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { retainTaskAgentEventLineage } from "./task-registry-agent-event-lineage.js";
import {
  sameTaskAgentEventSource,
  type TaskAgentEventSource,
} from "./task-registry-agent-event-source.js";
import type { TaskAgentEventTarget } from "./task-registry-agent-event-target.js";
import {
  captureTaskPersistenceReceipt,
  matchesTaskPersistenceReceipt,
} from "./task-registry-records.js";
import type { TaskPersistenceReceipt } from "./task-registry.types.js";

type YieldCall = {
  databaseKey: string;
  source: TaskAgentEventSource;
  expectedTask: TaskPersistenceReceipt;
  backing: TaskAgentEventTarget["backing"];
  callId: string;
  release?: () => void;
};
const latestByTask = new Map<string, YieldCall>();

export function clearLatestYieldCalls(databaseKey?: string): void {
  for (const [taskId, call] of latestByTask) {
    if (databaseKey === undefined || call.databaseKey === databaseKey) {
      forgetLatestYieldCall(taskId);
    }
  }
}

export function forgetLatestYieldCall(taskId: string): void {
  latestByTask.get(taskId)?.release?.();
  latestByTask.delete(taskId);
}

/** Only the latest matching call may clear a stored sessions_yield clue. */
export function captureLatestYieldCallId(
  task: TaskAgentEventTarget,
  source: TaskAgentEventSource,
  event: AgentEventPayload,
): string | undefined {
  const data = event.data;
  const callId = typeof data.toolCallId === "string" ? data.toolCallId.trim() : "";
  if (event.stream === "tool" && data.phase === "start") {
    forgetLatestYieldCall(task.taskId);
    const name = typeof data.name === "string" ? data.name.trim() : "";
    if (name === "sessions_yield" && callId) {
      const { admission } = captureOpenClawStateWorkerContext();
      const tracked: YieldCall = {
        databaseKey: admission.identity.key,
        source,
        expectedTask: captureTaskPersistenceReceipt(task),
        backing: task.backing,
        callId,
      };
      // An earlier queued lifecycle start can normalize this same task's createdAt.
      // Only its committed lineage may advance the call's exact identity fence.
      tracked.release = retainTaskAgentEventLineage(
        admission,
        task.runId,
        (previous, next) => {
          if (matchesTaskPersistenceReceipt(tracked.expectedTask, previous)) {
            tracked.expectedTask = captureTaskPersistenceReceipt(next);
          }
        },
        { source, backing: task.backing },
      );
      latestByTask.set(task.taskId, tracked);
    }
  }
  const latest = latestByTask.get(task.taskId);
  const matchingId =
    latest &&
    matchesTaskPersistenceReceipt(task, latest.expectedTask) &&
    isDeepStrictEqual(task.backing, latest.backing) &&
    sameTaskAgentEventSource(latest.source, source)
      ? latest.callId
      : undefined;
  if (
    (event.stream === "tool" && data.phase === "result" && callId === matchingId) ||
    (event.stream === "lifecycle" && (data.phase === "end" || data.phase === "error"))
  ) {
    forgetLatestYieldCall(task.taskId);
  }
  return matchingId;
}
