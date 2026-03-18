import { randomUUID } from "node:crypto";
import { getStateDb } from "../infra/state-db/index.js";
import type { Goal, GoalLevel, GoalStatus } from "./types.js";

type GoalRow = {
  id: string;
  workspace_id: string;
  parent_id: string | null;
  title: string;
  description: string | null;
  level: string;
  status: string;
  owner_agent_id: string | null;
  progress: number;
  created_at: number;
  updated_at: number;
};

function rowToGoal(row: GoalRow): Goal {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    parentId: row.parent_id,
    title: row.title,
    description: row.description,
    level: row.level as GoalLevel,
    status: row.status as GoalStatus,
    ownerAgentId: row.owner_agent_id,
    progress: row.progress,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listGoals(filters?: {
  workspaceId?: string;
  status?: GoalStatus;
  parentId?: string | null;
}): Goal[] {
  const db = getStateDb();
  let query = "SELECT * FROM op1_goals WHERE 1=1";
  const params: Array<string | number | bigint | null> = [];

  if (filters?.workspaceId) {
    query += " AND workspace_id = ?";
    params.push(filters.workspaceId);
  }
  if (filters?.status) {
    query += " AND status = ?";
    params.push(filters.status);
  }
  if (filters?.parentId !== undefined) {
    if (filters.parentId === null) {
      query += " AND parent_id IS NULL";
    } else {
      query += " AND parent_id = ?";
      params.push(filters.parentId);
    }
  }

  query += " ORDER BY updated_at DESC";

  const stmt = db.prepare(query);
  const rows = stmt.all(...params);
  return (rows as unknown as GoalRow[]).map(rowToGoal);
}

export function getGoal(goalId: string): Goal | null {
  const db = getStateDb();
  const stmt = db.prepare("SELECT * FROM op1_goals WHERE id = ?");
  const row = stmt.get(goalId);
  return row ? rowToGoal(row as unknown as GoalRow) : null;
}

export function createGoal(params: {
  workspaceId: string;
  title: string;
  description?: string;
  parentId?: string;
  level?: GoalLevel;
  ownerAgentId?: string;
}): Goal {
  const db = getStateDb();
  const id = randomUUID();
  const now = Math.floor(Date.now() / 1000);

  const insertStmt = db.prepare(`
    INSERT INTO op1_goals (
      id, workspace_id, parent_id, title, description,
      level, owner_agent_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertStmt.run(
    id,
    params.workspaceId,
    params.parentId || null,
    params.title,
    params.description || null,
    params.level || "objective",
    params.ownerAgentId || null,
    now,
    now,
  );

  return getGoal(id)!;
}

const VALID_GOAL_TRANSITIONS: Record<GoalStatus, Set<GoalStatus>> = {
  planned: new Set(["in_progress", "abandoned"]),
  in_progress: new Set(["planned", "achieved", "abandoned"]),
  achieved: new Set(["in_progress"]),
  abandoned: new Set(["planned", "in_progress"]),
};

export function updateGoal(
  goalId: string,
  updates: {
    title?: string;
    description?: string | null;
    status?: GoalStatus;
    level?: GoalLevel;
    progress?: number;
    ownerAgentId?: string | null;
    parentId?: string | null;
  },
): Goal {
  const db = getStateDb();
  const existing = getGoal(goalId);
  if (!existing) {
    throw new Error(`Goal not found: ${goalId}`);
  }

  const now = Math.floor(Date.now() / 1000);
  const sets: string[] = ["updated_at = ?"];
  const params: Array<string | number | bigint | null> = [now];

  if (updates.status !== undefined && updates.status !== existing.status) {
    const allowed = VALID_GOAL_TRANSITIONS[existing.status];
    if (!allowed || !allowed.has(updates.status)) {
      throw new Error(
        `Invalid goal status transition from ${existing.status} to ${updates.status}`,
      );
    }
    sets.push("status = ?");
    params.push(updates.status);
  }

  if (updates.title !== undefined) {
    sets.push("title = ?");
    params.push(updates.title);
  }
  if (updates.description !== undefined) {
    sets.push("description = ?");
    params.push(updates.description);
  }
  if (updates.level !== undefined) {
    sets.push("level = ?");
    params.push(updates.level);
  }
  if (updates.progress !== undefined) {
    if (updates.progress < 0 || updates.progress > 100) {
      throw new Error("Goal progress must be between 0 and 100");
    }
    sets.push("progress = ?");
    params.push(updates.progress);
  }
  if (updates.ownerAgentId !== undefined) {
    sets.push("owner_agent_id = ?");
    params.push(updates.ownerAgentId);
  }
  if (updates.parentId !== undefined) {
    // Avoid circular references. Very basic check: just don't set yourself as parent.
    // Real check would recursively traverse parents via listGoals to ensure not creating a cycle.
    if (updates.parentId === goalId) {
      throw new Error("Goal cannot be its own parent.");
    }
    sets.push("parent_id = ?");
    params.push(updates.parentId);
  }

  params.push(goalId);

  const stmt = db.prepare(`UPDATE op1_goals SET ${sets.join(", ")} WHERE id = ?`);
  stmt.run(...params);

  return getGoal(goalId)!;
}

export function deleteGoal(goalId: string): void {
  const db = getStateDb();
  const stmt = db.prepare("DELETE FROM op1_goals WHERE id = ?");
  stmt.run(goalId);
}
