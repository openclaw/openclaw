/**
 * JSON file-based fallback store for task registry when node:sqlite is unavailable.
 * This handles Homebrew Node.js builds that exclude experimental built-in modules.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveTaskRegistryDir, resolveTaskRegistryJsonPath } from "./task-registry.paths.js";
import type { TaskRegistryStoreSnapshot } from "./task-registry.store.js";
import type { TaskDeliveryState, TaskRecord } from "./task-registry.types.js";

const log = createSubsystemLogger("tasks/registry");

const TASK_REGISTRY_DIR_MODE = 0o700;
const TASK_REGISTRY_FILE_MODE = 0o600;

// In-memory cache for active session
let inMemoryTasks: Map<string, TaskRecord> = new Map();
let inMemoryDeliveryStates: Map<string, TaskDeliveryState> = new Map();
let jsonPath: string | null = null;

function getJsonPath(): string {
  if (!jsonPath) {
    jsonPath = resolveTaskRegistryJsonPath(process.env);
  }
  return jsonPath;
}

function ensureDirectory() {
  const dir = resolveTaskRegistryDir(process.env);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: TASK_REGISTRY_DIR_MODE });
  }
}

function writeJsonFile(tasks: Map<string, TaskRecord>, deliveryStates: Map<string, TaskDeliveryState>) {
  const path = getJsonPath();
  ensureDirectory();
  const data = {
    tasks: Array.from(tasks.values()),
    deliveryStates: Array.from(deliveryStates.values()),
    version: 1,
    updatedAt: Date.now(),
  };
  writeFileSync(path, JSON.stringify(data, null, 2), { mode: TASK_REGISTRY_FILE_MODE });
}

function readJsonFile(): { tasks: TaskRecord[]; deliveryStates: TaskDeliveryState[] } | null {
  const path = getJsonPath();
  if (!existsSync(path)) {
    return null;
  }
  try {
    const content = readFileSync(path, "utf-8");
    const data = JSON.parse(content);
    return {
      tasks: data.tasks || [],
      deliveryStates: data.deliveryStates || [],
    };
  } catch (err) {
    log("warn", "Failed to read task registry JSON file, starting fresh:", err);
    return null;
  }
}

export function loadTaskRegistryStateFromJson(): TaskRegistryStoreSnapshot {
  const data = readJsonFile();
  if (data) {
    inMemoryTasks = new Map(data.tasks.map((t) => [t.taskId, t]));
    inMemoryDeliveryStates = new Map(data.deliveryStates.map((s) => [s.taskId, s]));
    log("info", `Loaded ${inMemoryTasks.size} tasks from JSON store (node:sqlite unavailable)`);
  } else {
    inMemoryTasks = new Map();
    inMemoryDeliveryStates = new Map();
    log("info", "Starting with empty task registry (JSON store, node:sqlite unavailable)");
  }
  return {
    tasks: new Map(inMemoryTasks),
    deliveryStates: new Map(inMemoryDeliveryStates),
  };
}

export function saveTaskRegistryStateToJson(snapshot: TaskRegistryStoreSnapshot) {
  inMemoryTasks = new Map(snapshot.tasks);
  inMemoryDeliveryStates = new Map(snapshot.deliveryStates);
  writeJsonFile(inMemoryTasks, inMemoryDeliveryStates);
}

export function upsertTaskRegistryRecordToJson(task: TaskRecord) {
  inMemoryTasks.set(task.taskId, task);
  writeJsonFile(inMemoryTasks, inMemoryDeliveryStates);
}

export function upsertTaskWithDeliveryStateToJson(params: {
  task: TaskRecord;
  deliveryState?: TaskDeliveryState;
}) {
  inMemoryTasks.set(params.task.taskId, params.task);
  if (params.deliveryState) {
    inMemoryDeliveryStates.set(params.task.taskId, params.deliveryState);
  } else {
    inMemoryDeliveryStates.delete(params.task.taskId);
  }
  writeJsonFile(inMemoryTasks, inMemoryDeliveryStates);
}

export function deleteTaskRegistryRecordFromJson(taskId: string) {
  inMemoryTasks.delete(taskId);
  inMemoryDeliveryStates.delete(taskId);
  writeJsonFile(inMemoryTasks, inMemoryDeliveryStates);
}

export function deleteTaskAndDeliveryStateFromJson(taskId: string) {
  inMemoryTasks.delete(taskId);
  inMemoryDeliveryStates.delete(taskId);
  writeJsonFile(inMemoryTasks, inMemoryDeliveryStates);
}

export function upsertTaskDeliveryStateToJson(state: TaskDeliveryState) {
  inMemoryDeliveryStates.set(state.taskId, state);
  writeJsonFile(inMemoryTasks, inMemoryDeliveryStates);
}

export function deleteTaskDeliveryStateFromJson(taskId: string) {
  inMemoryDeliveryStates.delete(taskId);
  writeJsonFile(inMemoryTasks, inMemoryDeliveryStates);
}

export function closeTaskRegistryJsonStore() {
  // Write any pending changes
  writeJsonFile(inMemoryTasks, inMemoryDeliveryStates);
  inMemoryTasks = new Map();
  inMemoryDeliveryStates = new Map();
  jsonPath = null;
}
