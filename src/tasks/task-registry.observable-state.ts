import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { saveJsonFile } from "../infra/json-file.js";
import { resolveTaskStateDir } from "./task-registry.paths.js";
import { summarizeTaskRecords } from "./task-registry.summary.js";
import type { TaskRegistryObserverEvent, TaskRegistryObservers } from "./task-registry.store.js";
import type { TaskRecord, TaskRegistrySummary } from "./task-registry.types.js";

export type ObservableWorkerStateRecord = {
  id: string;
  runtime: TaskRecord["runtime"];
  status: TaskRecord["status"];
  task: string;
  ownerKey: string;
  scopeKind: TaskRecord["scopeKind"];
  childSessionKey?: string;
  agentId?: string;
  runId?: string;
  label?: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  lastEventAt?: number;
  error?: string;
  progressSummary?: string;
  terminalSummary?: string;
};

export type ObservableWorkerStateSnapshot = {
  version: 1;
  generatedAt: string;
  summary: TaskRegistrySummary;
  workers: ObservableWorkerStateRecord[];
};

const log = createSubsystemLogger("tasks/observable-state");

export function resolveObservableWorkerStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveTaskStateDir(env), "worker-state.json");
}

function toObservableWorkerStateRecord(task: TaskRecord): ObservableWorkerStateRecord {
  return {
    id: task.taskId,
    runtime: task.runtime,
    status: task.status,
    task: task.task,
    ownerKey: task.ownerKey,
    scopeKind: task.scopeKind,
    ...(task.childSessionKey ? { childSessionKey: task.childSessionKey } : {}),
    ...(task.agentId ? { agentId: task.agentId } : {}),
    ...(task.runId ? { runId: task.runId } : {}),
    ...(task.label ? { label: task.label } : {}),
    createdAt: task.createdAt,
    ...(task.startedAt != null ? { startedAt: task.startedAt } : {}),
    ...(task.endedAt != null ? { endedAt: task.endedAt } : {}),
    ...(task.lastEventAt != null ? { lastEventAt: task.lastEventAt } : {}),
    ...(task.error ? { error: task.error } : {}),
    ...(task.progressSummary ? { progressSummary: task.progressSummary } : {}),
    ...(task.terminalSummary ? { terminalSummary: task.terminalSummary } : {}),
  };
}

export function saveObservableWorkerState(params: {
  tasks: TaskRecord[];
  summary: TaskRegistrySummary;
  env?: NodeJS.ProcessEnv;
}) {
  const snapshot: ObservableWorkerStateSnapshot = {
    version: 1,
    generatedAt: new Date().toISOString(),
    summary: params.summary,
    workers: params.tasks.map((task) => toObservableWorkerStateRecord(task)),
  };
  saveJsonFile(resolveObservableWorkerStatePath(params.env), snapshot);
}

function writeObservableWorkerStateFromMap(tasks: ReadonlyMap<string, TaskRecord>) {
  const records = [...tasks.values()].toSorted((left, right) => {
    const leftAt = left.lastEventAt ?? left.startedAt ?? left.createdAt;
    const rightAt = right.lastEventAt ?? right.startedAt ?? right.createdAt;
    return rightAt - leftAt;
  });
  saveObservableWorkerState({
    tasks: records,
    summary: summarizeTaskRecords(records),
  });
}

export function createObservableWorkerStateObserver(): TaskRegistryObservers {
  const currentTasks = new Map<string, TaskRecord>();

  const updateFromEvent = (event: TaskRegistryObserverEvent) => {
    if (event.kind === "restored") {
      currentTasks.clear();
      for (const task of event.tasks) {
        currentTasks.set(task.taskId, { ...task });
      }
      return;
    }
    if (event.kind === "upserted") {
      currentTasks.set(event.task.taskId, { ...event.task });
      return;
    }
    currentTasks.delete(event.taskId);
  };

  return {
    onEvent(event) {
      updateFromEvent(event);
      try {
        writeObservableWorkerStateFromMap(currentTasks);
      } catch (error) {
        log.warn("Failed to persist observable worker state", { error });
      }
    },
  };
}
