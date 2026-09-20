import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { buildAgentRunTerminalOutcomeFromLifecycleEvent } from "../agents/agent-run-terminal-outcome.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
import type { serializeAgentSchemaInspectionError } from "../state/openclaw-agent-schema-inspection-response.js";
import { readTaskBackingInstance, type TaskBackingInstance } from "./task-backing-records.js";
import {
  appendTaskEvent,
  mapAgentRunTerminalOutcomeToTaskStatus,
  resolveTaskLifecycleTerminalError,
} from "./task-registry-common.js";
import {
  captureTaskPersistenceReceipt,
  matchesTaskPersistenceReceipt,
} from "./task-registry-records.js";
import { prepareTaskRecordUpdate } from "./task-registry-transition.operation.js";
import {
  isTerminalTaskStatus,
  type TaskPersistenceReceipt,
  type TaskRecord,
  type TaskStatus,
} from "./task-registry.types.js";

export const TASK_ACTIVITY_LIVENESS_WRITE_MS = 60_000;

export type TaskAgentEventChange = {
  kind: "progress" | "start" | "terminal";
  at: number;
  toolStarts: number;
  refreshStartedAt?: boolean;
  refreshError?: boolean;
  patch: Pick<Partial<TaskRecord>, "status" | "startedAt" | "endedAt" | "lastToolName" | "error">;
};

export type TaskAgentEventInput = {
  taskId: string;
  expectedTask: TaskPersistenceReceipt;
  backing?: TaskBackingInstance;
  change: TaskAgentEventChange;
};

/** Reduce accepted events to durable fields; tool arguments and streamed prose never enter the queue. */
export function captureTaskAgentEventChange(
  task: Pick<TaskRecord, "runtime">,
  event: AgentEventPayload,
  projectTerminal: boolean,
): TaskAgentEventChange | undefined {
  const change: TaskAgentEventChange = { kind: "progress", at: event.ts, toolStarts: 0, patch: {} };
  if (event.stream === "lifecycle") {
    change.refreshStartedAt = true;
    const { phase, startedAt } = event.data;
    if ((phase === "end" || phase === "error") && !projectTerminal) {
      return undefined;
    }
    if (typeof startedAt === "number" && Number.isFinite(startedAt)) {
      change.patch.startedAt = startedAt;
    }
    if (phase === "start") {
      change.kind = "start";
      change.patch.status = "running";
    } else if (phase === "end" || phase === "error") {
      const terminal = buildAgentRunTerminalOutcomeFromLifecycleEvent({
        phase,
        data: event.data,
        endedAt: event.data.endedAt ?? event.ts,
      });
      change.kind = "terminal";
      change.patch.status = mapAgentRunTerminalOutcomeToTaskStatus(terminal);
      change.patch.endedAt = terminal.endedAt ?? event.ts;
      const error = resolveTaskLifecycleTerminalError({
        runtime: task.runtime,
        status: change.patch.status,
        terminalReason: terminal.reason,
        error: terminal.error,
      });
      if (error) {
        change.patch.error = error;
      }
    }
  } else if (event.stream === "error") {
    change.refreshError = true;
    if (typeof event.data.error === "string") {
      change.patch.error = event.data.error;
    }
  } else if (event.stream === "tool" && event.data.phase === "start") {
    const name = typeof event.data.name === "string" ? event.data.name.trim() : "";
    if (name) {
      change.toolStarts = 1;
      change.patch.lastToolName = name;
    }
  }
  return change;
}

export function matchesTaskAgentEventTarget(task: TaskRecord, input: TaskAgentEventInput): boolean {
  return (
    matchesTaskPersistenceReceipt(task, input.expectedTask) &&
    isDeepStrictEqual(readTaskBackingInstance(task.detail), input.backing)
  );
}

/** Native compatibility consumption and worker persistence share this event decision. */
export function prepareTaskAgentEventUpdate(current: TaskRecord, input: TaskAgentEventInput) {
  if (isTerminalTaskStatus(current.status) || !matchesTaskAgentEventTarget(current, input)) {
    return null;
  }
  const { change } = input;
  const patch: Partial<TaskRecord> = { ...change.patch };
  if (change.refreshStartedAt && patch.startedAt === undefined && current.startedAt !== undefined) {
    patch.startedAt = current.startedAt;
  }
  if (change.refreshError && patch.error === undefined) {
    patch.error = current.error;
  }
  if (change.toolStarts) {
    patch.toolUseCount = (current.toolUseCount ?? 0) + change.toolStarts;
  }
  const lastEventAt = current.lastEventAt ?? current.startedAt ?? current.createdAt;
  if (
    Object.keys(patch).length === 0 &&
    change.at - lastEventAt < TASK_ACTIVITY_LIVENESS_WRITE_MS
  ) {
    return null;
  }
  patch.lastEventAt = change.at;
  const update = prepareTaskRecordUpdate(current, patch);
  return {
    ...update,
    patch,
    nextEvent: createTaskAgentEventPublication(update.task, current.status, change).nextEvent,
  };
}

export function createTaskAgentEventPublication(
  task: TaskRecord,
  previousStatus: TaskStatus,
  change: TaskAgentEventChange,
) {
  const nextEvent =
    change.patch.status && change.patch.status !== previousStatus
      ? appendTaskEvent({
          at: change.at,
          kind: change.patch.status,
          summary:
            task.status === "failed"
              ? task.error
              : task.status === "succeeded"
                ? task.terminalSummary
                : undefined,
        })
      : undefined;
  return {
    task,
    becomesTerminal: !isTerminalTaskStatus(previousStatus) && isTerminalTaskStatus(task.status),
    nextEvent,
  };
}

export type TaskAgentEventPublication = ReturnType<typeof createTaskAgentEventPublication>;

export type TaskAgentEventReceipt = NonNullable<ReturnType<typeof prepareTaskAgentEventUpdate>> & {
  cleanupError?: ReturnType<typeof serializeAgentSchemaInspectionError>;
};
export type TaskAgentEventWorkerOperations = {
  "tasks.observeAgentEvent": { input: TaskAgentEventInput; output: TaskAgentEventReceipt | null };
};

export function captureTaskAgentEventLineage(receipt: TaskAgentEventReceipt) {
  return {
    kind: "task-agent-event-commit",
    taskId: receipt.task.taskId,
    backing: readTaskBackingInstance(receipt.previous.detail),
    previous: captureTaskPersistenceReceipt(receipt.previous),
    next: captureTaskPersistenceReceipt(receipt.task),
  };
}

/** Only this operation's settled commit may advance its queued timestamp normalization. */
export function readTaskAgentEventCommittedTarget(
  facts: unknown,
  input: TaskAgentEventInput,
): TaskPersistenceReceipt {
  if (
    !isRecord(facts) ||
    facts.kind !== "task-agent-event-commit" ||
    facts.taskId !== input.taskId ||
    !isDeepStrictEqual(facts.backing, input.backing) ||
    !isRecord(facts.previous) ||
    !isRecord(facts.next)
  ) {
    throw new Error("Task event commit receipt differs from its retained owner");
  }
  const previous = facts.previous;
  const next = facts.next;
  for (const [key, value] of Object.entries(input.expectedTask)) {
    if (previous[key] !== value || (key !== "createdAt" && next[key] !== value)) {
      throw new Error("Task event commit receipt changed its fixed task identity");
    }
  }
  const createdAt = next.createdAt;
  if (
    typeof createdAt !== "number" ||
    !Number.isFinite(createdAt) ||
    createdAt > input.expectedTask.createdAt
  ) {
    throw new Error("Task event commit receipt has an invalid timestamp lineage");
  }
  return { ...input.expectedTask, createdAt };
}
