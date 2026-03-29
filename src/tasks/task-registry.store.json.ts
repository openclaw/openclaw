import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";
import type { TaskRecord } from "./task-registry.types.js";

type PersistedTaskRegistry = {
  version: 1;
  tasks: Record<string, TaskRecord>;
};

const TASK_REGISTRY_VERSION = 1 as const;

function resolveTaskStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.OPENCLAW_STATE_DIR?.trim();
  if (explicit) {
    return resolveStateDir(env);
  }
  if (env.VITEST || env.NODE_ENV === "test") {
    return path.join(os.tmpdir(), "openclaw-test-state", String(process.pid));
  }
  return resolveStateDir(env);
}

export function resolveTaskRegistryPath(): string {
  return path.join(resolveTaskStateDir(process.env), "tasks", "runs.json");
}

export function loadTaskRegistrySnapshotFromJson(): Map<string, TaskRecord> {
  const pathname = resolveTaskRegistryPath();
  const raw = loadJsonFile(pathname);
  if (!raw || typeof raw !== "object") {
    return new Map();
  }
  const record = raw as Partial<PersistedTaskRegistry>;
  if (record.version !== TASK_REGISTRY_VERSION) {
    return new Map();
  }
  const tasksRaw = record.tasks;
  if (!tasksRaw || typeof tasksRaw !== "object") {
    return new Map();
  }
  const out = new Map<string, TaskRecord>();
  for (const [taskId, entry] of Object.entries(tasksRaw)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    if (!entry.taskId || typeof entry.taskId !== "string") {
      continue;
    }
    out.set(taskId, entry);
  }
  return out;
}

export function saveTaskRegistrySnapshotToJson(tasks: ReadonlyMap<string, TaskRecord>) {
  const pathname = resolveTaskRegistryPath();
  const serialized: Record<string, TaskRecord> = {};
  for (const [taskId, entry] of tasks.entries()) {
    serialized[taskId] = entry;
  }
  const out: PersistedTaskRegistry = {
    version: TASK_REGISTRY_VERSION,
    tasks: serialized,
  };
  saveJsonFile(pathname, out);
}
