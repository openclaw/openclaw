import path from "node:path";
import { STATE_DIR } from "../config/paths.js";
import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";
import type { TaskList, TaskRecord } from "./task-list.js";

type SerializedTaskRecord = TaskRecord;

type SerializedTaskList = Omit<TaskList, "tasks"> & {
  tasks: Record<string, SerializedTaskRecord>;
};

type PersistedTaskStore = {
  version: 1;
  lists: Record<string, SerializedTaskList>;
};

export function resolveTaskStorePath(): string {
  return path.join(STATE_DIR, "subagents", "tasks.json");
}

export function loadTasksFromDisk(): Map<string, TaskList> {
  const pathname = resolveTaskStorePath();
  const raw = loadJsonFile(pathname);
  if (!raw || typeof raw !== "object") {
    return new Map();
  }
  const record = raw as Partial<PersistedTaskStore>;
  if (record.version !== 1) {
    return new Map();
  }
  const listsRaw = record.lists;
  if (!listsRaw || typeof listsRaw !== "object") {
    return new Map();
  }
  const out = new Map<string, TaskList>();
  for (const [listId, entry] of Object.entries(listsRaw)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    if (!entry.listId || typeof entry.listId !== "string") {
      continue;
    }
    const taskMap = new Map<string, TaskRecord>();
    if (entry.tasks && typeof entry.tasks === "object") {
      for (const [id, task] of Object.entries(entry.tasks)) {
        if (task && typeof task === "object") {
          taskMap.set(id, task);
        }
      }
    }
    out.set(listId, {
      ...entry,
      tasks: taskMap,
    } as TaskList);
  }
  return out;
}

export function saveTasksToDisk(lists: Map<string, TaskList>) {
  const pathname = resolveTaskStorePath();
  const serialized: Record<string, SerializedTaskList> = {};
  for (const [listId, list] of lists.entries()) {
    const tasks: Record<string, SerializedTaskRecord> = {};
    for (const [id, task] of list.tasks.entries()) {
      tasks[id] = task;
    }
    serialized[listId] = {
      ...list,
      tasks,
    };
  }
  const out: PersistedTaskStore = {
    version: 1,
    lists: serialized,
  };
  saveJsonFile(pathname, out);
}
