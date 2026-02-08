import type { GatewayRequestHandlers } from "./types.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";

// Mission Control Task types
export type MissionControlTaskStatus =
  | "pending"
  | "running"
  | "review"
  | "revising"
  | "done"
  | "failed";

export type MissionControlTask = {
  id: string;
  title: string;
  description: string;
  status: MissionControlTaskStatus;
  agentId?: string | null;
  sessionKey?: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt?: number | null;
  finishedAt?: number | null;
  resultSummary?: string | null;
  errorMessage?: string | null;
  priority?: number;
  tags?: string[];
  failCount?: number;
  revisionCount?: number;
};

export type MissionControlTasksListResult = {
  tasks: MissionControlTask[];
};

export type MissionControlTaskCreate = {
  title: string;
  description: string;
  status?: MissionControlTaskStatus;
  priority?: number;
  tags?: string[];
};

export type MissionControlTaskPatch = {
  title?: string;
  description?: string;
  status?: MissionControlTaskStatus;
  agentId?: string | null;
  sessionKey?: string | null;
  priority?: number;
  tags?: string[];
  resultSummary?: string | null;
  errorMessage?: string | null;
  startedAt?: number | null;
  finishedAt?: number | null;
  failCount?: number;
  revisionCount?: number;
};

// In-memory store for mission control tasks (backed by SQLite in production)
let tasks: MissionControlTask[] = [];
let db: import("better-sqlite3").Database | null = null;

function initDb(): void {
  if (db) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require("better-sqlite3");
    const path = require("path");
    const os = require("os");
    const dbPath = path.join(
      os.homedir(),
      ".openclaw",
      "workspace-dev",
      "data",
      "mission_control.db",
    );
    db = new Database(dbPath);
  } catch {
    // SQLite not available, use in-memory store
    db = null;
  }
}

function dbToTask(row: unknown): MissionControlTask {
  const r = row as Record<string, unknown>;
  return {
    id: String(r.id),
    title: String(r.title),
    description: String(r.description ?? ""),
    status: String(r.status) as MissionControlTaskStatus,
    agentId: r.agent_id ? String(r.agent_id) : null,
    sessionKey: r.session_key ? String(r.session_key) : null,
    createdAt: Number(r.created_at) * 1000,
    updatedAt: Number(r.updated_at) * 1000,
    startedAt: r.started_at ? Number(r.started_at) * 1000 : null,
    finishedAt: r.finished_at ? Number(r.finished_at) * 1000 : null,
    resultSummary: r.result_summary ? String(r.result_summary) : null,
    errorMessage: r.error_message ? String(r.error_message) : null,
    priority: r.priority ? Number(r.priority) : 0,
    tags: r.tags ? String(r.tags).split(",").filter(Boolean) : [],
    failCount: r.fail_count ? Number(r.fail_count) : 0,
    revisionCount: r.revision_count ? Number(r.revision_count) : 0,
  };
}

function fetchTasksFromDb(): MissionControlTask[] {
  if (!db) return tasks;
  try {
    const rows = db.prepare("SELECT * FROM jobs ORDER BY created_at DESC").all();
    return rows.map(dbToTask);
  } catch {
    return tasks;
  }
}

function insertTaskToDb(task: MissionControlTask): void {
  if (!db) {
    tasks.push(task);
    return;
  }
  try {
    db.prepare(`
      INSERT INTO jobs (id, type, title, description, status, agent_id, session_key, created_at, updated_at, priority, tags, fail_count, revision_count)
      VALUES (?, 'task', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      task.id,
      task.title,
      task.description,
      task.status,
      task.agentId,
      task.sessionKey,
      Math.floor(task.createdAt / 1000),
      Math.floor(task.updatedAt / 1000),
      task.priority ?? 0,
      (task.tags ?? []).join(","),
      task.failCount ?? 0,
      task.revisionCount ?? 0,
    );
  } catch {
    tasks.push(task);
  }
}

function updateTaskInDb(task: MissionControlTask): void {
  if (!db) {
    const idx = tasks.findIndex((t) => t.id === task.id);
    if (idx >= 0) tasks[idx] = task;
    return;
  }
  try {
    db.prepare(`
      UPDATE jobs SET 
        title = ?, 
        description = ?, 
        status = ?, 
        agent_id = ?, 
        session_key = ?, 
        updated_at = ?, 
        started_at = ?, 
        finished_at = ?, 
        result_summary = ?, 
        error_message = ?, 
        priority = ?, 
        tags = ?, 
        fail_count = ?, 
        revision_count = ?
      WHERE id = ?
    `).run(
      task.title,
      task.description,
      task.status,
      task.agentId,
      task.sessionKey,
      Math.floor(task.updatedAt / 1000),
      task.startedAt ? Math.floor(task.startedAt / 1000) : null,
      task.finishedAt ? Math.floor(task.finishedAt / 1000) : null,
      task.resultSummary,
      task.errorMessage,
      task.priority ?? 0,
      (task.tags ?? []).join(","),
      task.failCount ?? 0,
      task.revisionCount ?? 0,
      task.id,
    );
  } catch {
    const idx = tasks.findIndex((t) => t.id === task.id);
    if (idx >= 0) tasks[idx] = task;
  }
}

function deleteTaskFromDb(id: string): void {
  if (!db) {
    tasks = tasks.filter((t) => t.id !== id);
    return;
  }
  try {
    db.prepare("DELETE FROM jobs WHERE id = ?").run(id);
  } catch {
    tasks = tasks.filter((t) => t.id !== id);
  }
}

export const missionControlHandlers: GatewayRequestHandlers = {
  "missionControl.list": async ({ respond }) => {
    initDb();
    const allTasks = fetchTasksFromDb();
    respond(true, { tasks: allTasks }, undefined);
  },

  "missionControl.create": async ({ params, respond, context }) => {
    initDb();
    const p = params as MissionControlTaskCreate;

    if (!p.title?.trim()) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "title is required"));
      return;
    }

    const now = Date.now();
    const task: MissionControlTask = {
      id: `mc-${now}-${Math.random().toString(36).slice(2, 8)}`,
      title: p.title.trim(),
      description: p.description?.trim() ?? "",
      status: p.status ?? "pending",
      agentId: null,
      sessionKey: null,
      createdAt: now,
      updatedAt: now,
      priority: p.priority ?? 0,
      tags: p.tags ?? [],
      failCount: 0,
      revisionCount: 0,
    };

    insertTaskToDb(task);
    respond(true, { task }, undefined);
  },

  "missionControl.update": async ({ params, respond }) => {
    initDb();
    const p = params as { id: string; patch: MissionControlTaskPatch };

    if (!p.id) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id is required"));
      return;
    }

    const allTasks = fetchTasksFromDb();
    const task = allTasks.find((t) => t.id === p.id);

    if (!task) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, `task not found: ${p.id}`));
      return;
    }

    const patch = p.patch;
    if (patch.title !== undefined) task.title = patch.title;
    if (patch.description !== undefined) task.description = patch.description;
    if (patch.status !== undefined) {
      const oldStatus = task.status;
      task.status = patch.status;
      // Auto-update timestamps based on status transitions
      if (oldStatus !== "running" && patch.status === "running" && !task.startedAt) {
        task.startedAt = Date.now();
      }
      if (["done", "failed"].includes(patch.status) && !task.finishedAt) {
        task.finishedAt = Date.now();
      }
    }
    if (patch.agentId !== undefined) task.agentId = patch.agentId;
    if (patch.sessionKey !== undefined) task.sessionKey = patch.sessionKey;
    if (patch.priority !== undefined) task.priority = patch.priority;
    if (patch.tags !== undefined) task.tags = patch.tags;
    if (patch.resultSummary !== undefined) task.resultSummary = patch.resultSummary;
    if (patch.errorMessage !== undefined) task.errorMessage = patch.errorMessage;
    if (patch.startedAt !== undefined) task.startedAt = patch.startedAt;
    if (patch.finishedAt !== undefined) task.finishedAt = patch.finishedAt;
    if (patch.failCount !== undefined) task.failCount = patch.failCount;
    if (patch.revisionCount !== undefined) task.revisionCount = patch.revisionCount;

    task.updatedAt = Date.now();

    updateTaskInDb(task);
    respond(true, { task }, undefined);
  },

  "missionControl.delete": async ({ params, respond }) => {
    initDb();
    const p = params as { id: string };

    if (!p.id) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "id is required"));
      return;
    }

    deleteTaskFromDb(p.id);
    respond(true, { ok: true }, undefined);
  },

  "missionControl.spawnAgent": async ({ params, respond, context }) => {
    initDb();
    const p = params as {
      taskId: string;
      agentId?: string;
      message?: string;
    };

    if (!p.taskId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "taskId is required"));
      return;
    }

    const allTasks = fetchTasksFromDb();
    const task = allTasks.find((t) => t.id === p.taskId);

    if (!task) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `task not found: ${p.taskId}`),
      );
      return;
    }

    // Use sessions_spawn via the context's session manager
    const agentId = p.agentId ?? "default";
    const message = p.message ?? `Work on task: ${task.title}\n\n${task.description}`;

    try {
      // Spawn a new sub-agent session for this task
      const result = await context.sessionManager?.spawnSession?.({
        parentSessionId: null,
        agentId,
        label: `mc-task-${task.id}`,
        message,
        delivery: { mode: "none" },
      });

      // Update task with agent assignment
      task.agentId = agentId;
      task.sessionKey = result?.sessionKey ?? null;
      task.status = "running";
      task.startedAt = Date.now();
      task.updatedAt = Date.now();
      updateTaskInDb(task);

      respond(
        true,
        {
          task,
          sessionKey: result?.sessionKey,
          sessionId: result?.sessionId,
        },
        undefined,
      );
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `failed to spawn agent: ${String(err)}`),
      );
    }
  },
};
