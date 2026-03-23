import { randomUUID } from "node:crypto";
import { getStateDb } from "../infra/state-db/index.js";
import type { Task, TaskComment, TaskStatus, TaskPriority, AuthorType } from "./types.js";

type TaskRow = {
  id: string;
  workspace_id: string;
  project_id: string | null;
  goal_id: string | null;
  parent_id: string | null;
  identifier: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assignee_agent_id: string | null;
  billing_code: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
};
type CommentRow = {
  id: string;
  task_id: string;
  author_id: string;
  author_type: string;
  body: string;
  created_at: number;
};

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    goalId: row.goal_id,
    parentId: row.parent_id,
    identifier: row.identifier,
    title: row.title,
    description: row.description,
    status: row.status as TaskStatus,
    priority: row.priority as TaskPriority,
    assigneeAgentId: row.assignee_agent_id,
    billingCode: row.billing_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function rowToComment(row: CommentRow): TaskComment {
  return {
    id: row.id,
    taskId: row.task_id,
    authorId: row.author_id,
    authorType: row.author_type as AuthorType,
    body: row.body,
    createdAt: row.created_at,
  };
}

// Ensure unique identifier per workspace like OP1-XXX
// We use a transaction because the logic involves checking the workspace's taskCounter.
function generateIdentifier(workspaceId: string): string {
  const db = getStateDb();
  const getWs = db.prepare("SELECT task_prefix, task_counter FROM op1_workspaces WHERE id = ?");
  const ws = getWs.get(workspaceId) as { task_prefix: string; task_counter: number } | undefined;
  if (!ws) {
    throw new Error(`Workspace not found: ${workspaceId}`);
  }

  const nextCount = ws.task_counter + 1;
  const updateWs = db.prepare("UPDATE op1_workspaces SET task_counter = ? WHERE id = ?");
  updateWs.run(nextCount, workspaceId);

  return `${ws.task_prefix}-${String(nextCount).padStart(3, "0")}`;
}

export function listTasks(filters?: {
  workspaceId?: string;
  status?: TaskStatus;
  assigneeAgentId?: string;
  goalId?: string;
  projectId?: string;
}): Task[] {
  const db = getStateDb();
  let query = "SELECT * FROM op1_tasks WHERE 1=1";
  const params: Array<string | number | bigint | null> = [];

  if (filters?.workspaceId) {
    query += " AND workspace_id = ?";
    params.push(filters.workspaceId);
  }
  if (filters?.status) {
    query += " AND status = ?";
    params.push(filters.status);
  }
  if (filters?.assigneeAgentId) {
    query += " AND assignee_agent_id = ?";
    params.push(filters.assigneeAgentId);
  }
  if (filters?.goalId) {
    query += " AND goal_id = ?";
    params.push(filters.goalId);
  }
  if (filters?.projectId) {
    query += " AND project_id = ?";
    params.push(filters.projectId);
  }

  query += " ORDER BY updated_at DESC";

  const stmt = db.prepare(query);
  const rows = stmt.all(...params);
  return (rows as unknown as TaskRow[]).map(rowToTask);
}

export function getTask(taskId: string): Task | null {
  const db = getStateDb();
  const stmt = db.prepare("SELECT * FROM op1_tasks WHERE id = ?");
  const row = stmt.get(taskId);
  return row ? rowToTask(row as unknown as TaskRow) : null;
}

export function getTaskByIdentifier(workspaceId: string, identifier: string): Task | null {
  const db = getStateDb();
  const stmt = db.prepare("SELECT * FROM op1_tasks WHERE workspace_id = ? AND identifier = ?");
  const row = stmt.get(workspaceId, identifier);
  return row ? rowToTask(row as unknown as TaskRow) : null;
}

export function createTask(params: {
  workspaceId: string;
  title: string;
  description?: string;
  projectId?: string;
  goalId?: string;
  parentId?: string;
  priority?: TaskPriority;
  assigneeAgentId?: string;
  billingCode?: string;
}): Task {
  const db = getStateDb();

  let taskInfo!: { id: string; identifier: string; now: number };

  db.exec("BEGIN");
  try {
    const identifier = generateIdentifier(params.workspaceId);
    taskInfo = { id: randomUUID(), identifier, now: Math.floor(Date.now() / 1000) };

    const insertStmt = db.prepare(`
      INSERT INTO op1_tasks (
        id, workspace_id, project_id, goal_id, parent_id, identifier, title, description,
        priority, assignee_agent_id, billing_code, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertStmt.run(
      taskInfo.id,
      params.workspaceId,
      params.projectId || null,
      params.goalId || null,
      params.parentId || null,
      taskInfo.identifier,
      params.title,
      params.description || null,
      params.priority || "medium",
      params.assigneeAgentId || null,
      params.billingCode || null,
      taskInfo.now,
      taskInfo.now,
    );
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  return getTask(taskInfo.id)!;
}

const VALID_TRANSITIONS: Record<TaskStatus, Set<TaskStatus>> = {
  backlog: new Set(["todo", "in_progress", "cancelled"]),
  todo: new Set(["backlog", "in_progress", "blocked", "cancelled"]),
  in_progress: new Set(["todo", "in_review", "blocked", "done", "cancelled"]),
  in_review: new Set(["in_progress", "done", "cancelled"]),
  blocked: new Set(["todo", "in_progress", "cancelled"]),
  done: new Set(["todo", "in_progress", "backlog"]), // reopen
  cancelled: new Set(["todo", "backlog"]), // reopen
};

export function updateTask(
  taskId: string,
  updates: {
    title?: string;
    description?: string | null;
    status?: TaskStatus;
    priority?: TaskPriority;
    assigneeAgentId?: string | null;
    billingCode?: string | null;
    goalId?: string | null;
    projectId?: string | null;
  },
): Task {
  const db = getStateDb();
  const existing = getTask(taskId);
  if (!existing) {
    throw new Error(`Task not found: ${taskId}`);
  }

  const now = Math.floor(Date.now() / 1000);
  const sets: string[] = ["updated_at = ?"];
  const params: Array<string | number | bigint | null> = [now];

  if (updates.status !== undefined && updates.status !== existing.status) {
    const allowed = VALID_TRANSITIONS[existing.status];
    if (!allowed || !allowed.has(updates.status)) {
      throw new Error(`Invalid status transition from ${existing.status} to ${updates.status}`);
    }
  }

  if (updates.title !== undefined) {
    sets.push("title = ?");
    params.push(updates.title);
  }
  if (updates.description !== undefined) {
    sets.push("description = ?");
    params.push(updates.description);
  }
  if (updates.status !== undefined) {
    sets.push("status = ?");
    params.push(updates.status);

    if (updates.status === "done" || updates.status === "cancelled") {
      sets.push("completed_at = ?");
      params.push(now);
    } else {
      sets.push("completed_at = NULL");
    }
  }
  if (updates.priority !== undefined) {
    sets.push("priority = ?");
    params.push(updates.priority);
  }
  if (updates.assigneeAgentId !== undefined) {
    sets.push("assignee_agent_id = ?");
    params.push(updates.assigneeAgentId);
  }
  if (updates.billingCode !== undefined) {
    sets.push("billing_code = ?");
    params.push(updates.billingCode);
  }
  if (updates.goalId !== undefined) {
    sets.push("goal_id = ?");
    params.push(updates.goalId);
  }
  if (updates.projectId !== undefined) {
    sets.push("project_id = ?");
    params.push(updates.projectId);
  }

  params.push(taskId);

  const stmt = db.prepare(`UPDATE op1_tasks SET ${sets.join(", ")} WHERE id = ?`);
  stmt.run(...params);

  return getTask(taskId)!;
}

// ── Comments ─────────────────────────────────────────────────────────────────

export function listTaskComments(taskId: string): TaskComment[] {
  const db = getStateDb();
  const stmt = db.prepare(
    "SELECT * FROM op1_task_comments WHERE task_id = ? ORDER BY created_at ASC",
  );
  const rows = stmt.all(taskId);
  return (rows as unknown as CommentRow[]).map(rowToComment);
}

export function addTaskComment(params: {
  taskId: string;
  authorId: string;
  authorType: AuthorType;
  body: string;
}): TaskComment {
  const db = getStateDb();
  const existing = getTask(params.taskId);
  if (!existing) {
    throw new Error(`Task not found: ${params.taskId}`);
  }

  const id = randomUUID();
  const now = Math.floor(Date.now() / 1000);

  const stmt = db.prepare(`
    INSERT INTO op1_task_comments (id, task_id, author_id, author_type, body, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  stmt.run(id, params.taskId, params.authorId, params.authorType, params.body, now);

  const newRow = db.prepare("SELECT * FROM op1_task_comments WHERE id = ?").get(id);
  return rowToComment(newRow as unknown as CommentRow);
}
