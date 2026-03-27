import crypto from "node:crypto";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createBrainMcpClient, type BrainMcpClient } from "../memory/brain-mcp-client.js";
import { loadTasksFromDisk, saveTasksToDisk } from "./task-list.store.js";
import { TRIUMPH_WORKSPACE_ID } from "./triumph-constants.js";

const log = createSubsystemLogger("task-list");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskStatus = "pending" | "in_progress" | "done" | "failed" | "skipped";
export type TaskListStatus = "open" | "completed" | "partial" | "failed";

export type TaskRecord = {
  taskId: string;
  listId: string;
  subject: string;
  description: string;
  agentId: string;
  status: TaskStatus;
  missionId?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  result?: string;
  brainMemoryId?: string;
};

export type TaskList = {
  listId: string;
  label: string;
  requesterSessionKey: string;
  tasks: Map<string, TaskRecord>;
  createdAt: number;
  listStatus?: TaskListStatus;
  closedAt?: number;
  brainMemoryId?: string;
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const taskLists = new Map<string, TaskList>();

/** Reverse index: missionId → listId (populated when Luna includes listId in mission label) */
const missionToList = new Map<string, string>();

/** Lazily-created Brain MCP client */
let _brainClient: BrainMcpClient | null = null;
function getBrainClient(): BrainMcpClient {
  if (!_brainClient) {
    // TODO: re-enable after upstream API stabilizes — brainTiered was removed from MemoryConfig
    _brainClient = createBrainMcpClient({ mcporterPath: "mcporter", timeoutMs: 5000 });
  }
  return _brainClient;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createTaskList(params: {
  label: string;
  tasks: { subject: string; description: string; agentId: string }[];
  requesterSessionKey: string;
}): { listId: string; tasks: { taskId: string; subject: string; agentId: string }[] } {
  const listId = crypto.randomUUID();
  const taskMap = new Map<string, TaskRecord>();
  const created: { taskId: string; subject: string; agentId: string }[] = [];

  for (const t of params.tasks) {
    const taskId = crypto.randomUUID();
    taskMap.set(taskId, {
      taskId,
      listId,
      subject: t.subject,
      description: t.description,
      agentId: t.agentId,
      status: "pending",
      createdAt: Date.now(),
    });
    created.push({ taskId, subject: t.subject, agentId: t.agentId });
  }

  const list: TaskList = {
    listId,
    label: params.label,
    requesterSessionKey: params.requesterSessionKey,
    tasks: taskMap,
    createdAt: Date.now(),
    listStatus: "open", // Initialize as open
  };

  taskLists.set(listId, list);
  persist();

  log.info(`[task-list] created "${params.label}" with ${created.length} tasks (listId=${listId})`);

  // Fire-and-forget Brain MCP sync
  void syncTaskListToBrain(list);

  return { listId, tasks: created };
}

export function getTaskList(listId: string): TaskList | undefined {
  return taskLists.get(listId);
}

export function listTaskLists(requesterSessionKey?: string): TaskList[] {
  const all = [...taskLists.values()];
  if (requesterSessionKey) {
    return all.filter((l) => l.requesterSessionKey === requesterSessionKey);
  }
  return all;
}

export function updateTaskStatus(taskId: string, status: TaskStatus, result?: string): boolean {
  for (const list of taskLists.values()) {
    const task = list.tasks.get(taskId);
    if (task) {
      task.status = status;
      if (result !== undefined) {
        task.result = result.slice(0, 500);
      }
      if (status === "in_progress" && !task.startedAt) {
        task.startedAt = Date.now();
      }
      if (status === "done" || status === "failed" || status === "skipped") {
        task.completedAt = Date.now();
      }
      persist();
      log.info(`[task-list] task ${taskId.slice(0, 8)} → ${status}`);
      return true;
    }
  }
  // Fall through: check if caller passed a listId instead of a taskId
  const list = taskLists.get(taskId);
  if (list) {
    const listStatus: TaskListStatus =
      status === "done" ? "completed" : status === "failed" ? "failed" : "partial";
    log.info(
      `[task-list] updating list ${taskId.slice(0, 8)} → ${listStatus} (from task status ${status})`,
    );
    return updateListStatus(taskId, listStatus, result);
  }

  log.warn(`[task-list] task/list ${taskId.slice(0, 8)} not found in any list`);
  return false;
}

/**
 * Explicitly close a task list (called by Luna in Step 6 of /delegate).
 * Also called automatically by markTaskByMission when all tasks reach a terminal state.
 */
export function updateListStatus(listId: string, status: TaskListStatus, result?: string): boolean {
  const list = taskLists.get(listId);
  if (!list) {
    return false;
  }
  list.listStatus = status;
  list.closedAt = Date.now();
  if (result !== undefined && list.tasks.size > 0) {
    // Store result on the first task as a summary if provided
    const firstTask = [...list.tasks.values()][0];
    if (firstTask && !firstTask.result) {
      firstTask.result = result.slice(0, 500);
    }
  }
  persist();
  log.info(`[task-list] list "${list.label}" (${listId.slice(0, 8)}) → ${status}`);
  void syncTaskListToBrain(list);
  return true;
}

/**
 * Link a mission to a task list. Called when a mission label contains `listId:<id>:`.
 * This is idempotent.
 */
export function linkMissionToTaskList(missionId: string, listId: string): void {
  missionToList.set(missionId, listId);
}

/**
 * Called from `handleSubtaskCompletion()` when a subtask starts running.
 * Marks the first pending task for the matching agent in the linked list as in_progress.
 */
export function startTaskByMission(missionId: string, subtaskId: string, agentId?: string): void {
  const listId = missionToList.get(missionId);
  if (!listId) {
    return;
  }

  const list = taskLists.get(listId);
  if (!list) {
    return;
  }

  // Try to match by agentId first (accurate), fall back to first-pending (positional)
  let matched: TaskRecord | undefined;
  if (agentId) {
    for (const task of list.tasks.values()) {
      if (task.status === "pending" && !task.missionId && task.agentId === agentId) {
        matched = task;
        break;
      }
    }
  }
  if (!matched) {
    for (const task of list.tasks.values()) {
      if (task.status === "pending" && !task.missionId) {
        matched = task;
        break;
      }
    }
  }
  if (!matched) {
    return;
  }

  matched.missionId = missionId;
  matched.status = "in_progress";
  matched.startedAt = Date.now();
  persist();
  log.info(
    `[task-list] auto-link: task "${matched.subject}" (${matched.agentId}) → mission ${missionId.slice(0, 8)} subtask ${subtaskId}`,
  );
}

/**
 * Called from `checkMissionCompletion()` when a mission finishes.
 * Marks all linked tasks in the list based on mission status.
 */
export function markTaskByMission(missionId: string, missionStatus: string): void {
  const listId = missionToList.get(missionId);
  if (!listId) {
    return;
  }

  const list = taskLists.get(listId);
  if (!list) {
    return;
  }

  for (const task of list.tasks.values()) {
    if (task.missionId !== missionId) {
      continue;
    }
    if (task.status === "done" || task.status === "failed" || task.status === "skipped") {
      continue;
    }

    if (missionStatus === "completed") {
      task.status = "done";
    } else if (missionStatus === "failed") {
      task.status = "failed";
    } else if (missionStatus === "partial") {
      // Keep current status — some subtasks may have succeeded
    }
    task.completedAt = Date.now();
  }

  persist();
  log.info(
    `[task-list] mission ${missionId.slice(0, 8)} ${missionStatus} → updated tasks in list "${list.label}"`,
  );

  // Auto-close list when all tasks have reached a terminal state
  const allTasks = [...list.tasks.values()];
  const terminalStatuses = new Set<TaskStatus>(["done", "failed", "skipped"]);
  const allTerminal = allTasks.every((t) => terminalStatuses.has(t.status));
  if (allTerminal && !list.listStatus) {
    const hasFailed = allTasks.some((t) => t.status === "failed");
    const hasDone = allTasks.some((t) => t.status === "done");
    const autoStatus: TaskListStatus =
      hasFailed && hasDone ? "partial" : hasFailed ? "failed" : "completed";
    list.listStatus = autoStatus;
    list.closedAt = Date.now();
    persist();
    log.info(
      `[task-list] auto-closed list "${list.label}" (${listId.slice(0, 8)}) → ${autoStatus}`,
    );
  }

  // Fire-and-forget Brain MCP sync
  void syncTaskListToBrain(list);
}

/**
 * Parse a mission label for `listId:<uuid>:` prefix and register the link.
 * Returns the parsed listId or undefined if not found.
 */
export function parseMissionLabelForListId(
  missionLabel: string,
  missionId: string,
): string | undefined {
  const match = missionLabel.match(/^listId:([0-9a-f-]{36}):/i);
  if (match) {
    const listId = match[1];
    linkMissionToTaskList(missionId, listId);
    log.info(`[task-list] linked mission ${missionId.slice(0, 8)} → list ${listId.slice(0, 8)}`);
    return listId;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatTaskList(list: TaskList): string {
  const lines: string[] = [`Task List: "${list.label}" (listId: ${list.listId})\n`];

  let idx = 0;
  for (const task of list.tasks.values()) {
    idx++;
    const icon = statusIcon(task.status);
    const agentTag = `→ ${task.agentId}`;
    const statusSuffix =
      task.status === "done"
        ? " (done)"
        : task.status === "in_progress"
          ? " (in_progress)"
          : task.status === "failed"
            ? " (failed)"
            : task.status === "skipped"
              ? " (skipped)"
              : "";
    lines.push(`${icon} T${idx}: ${task.subject} ${agentTag}${statusSuffix}`);
  }

  const total = list.tasks.size;
  const done = [...list.tasks.values()].filter((t) => t.status === "done").length;
  lines.push(`\nProgress: ${done}/${total} complete`);

  return lines.join("\n");
}

function statusIcon(status: TaskStatus): string {
  switch (status) {
    case "done":
      return "[v]";
    case "in_progress":
      return "[>]";
    case "failed":
      return "[x]";
    case "skipped":
      return "[-]";
    case "pending":
    default:
      return "[ ]";
  }
}

// ---------------------------------------------------------------------------
// Persistence & Brain MCP sync
// ---------------------------------------------------------------------------

function persist() {
  saveTasksToDisk(taskLists);
}

async function syncTaskListToBrain(list: TaskList): Promise<void> {
  try {
    const content = formatTaskListForBrain(list);
    await getBrainClient().createMemory({
      content,
      workspaceId: TRIUMPH_WORKSPACE_ID,
      metadata: {
        type: "task_list",
        listId: list.listId,
        label: list.label,
        date: new Date().toISOString().slice(0, 10),
      },
    });
  } catch {
    // Never block on Brain MCP sync
  }
}

function formatTaskListForBrain(list: TaskList): string {
  const lines: string[] = [`TASK_LIST: ${list.label}`];
  for (const task of list.tasks.values()) {
    lines.push(`- [${task.status}] ${task.subject} (${task.agentId})`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export function initTaskSystem(): void {
  const loaded = loadTasksFromDisk();
  for (const [id, list] of loaded.entries()) {
    taskLists.set(id, list);
    // Rebuild missionToList reverse index from persisted task records
    for (const task of list.tasks.values()) {
      if (task.missionId) {
        missionToList.set(task.missionId, list.listId);
      }
    }
  }
  log.info(`[task-list] restored ${taskLists.size} task lists from disk`);
}
