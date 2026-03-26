import { randomUUID } from "node:crypto";
import { getStateDb } from "../infra/state-db/index.js";
import type {
  Routine,
  RoutineListItem,
  RoutineRun,
  RoutineTrigger,
} from "./types.js";

// ── Row types ─────────────────────────────────────────────────────────────────

type RoutineRow = {
  id: string;
  workspace_id: string;
  project_id: string | null;
  goal_id: string | null;
  parent_issue_id: string | null;
  title: string;
  description: string | null;
  assignee_agent_id: string;
  priority: string;
  status: string;
  concurrency_policy: string;
  catch_up_policy: string;
  created_by_agent_id: string | null;
  created_by_user_id: string | null;
  updated_by_agent_id: string | null;
  updated_by_user_id: string | null;
  last_triggered_at: number | null;
  last_enqueued_at: number | null;
  created_at: number;
  updated_at: number;
};

type RoutineTriggerRow = {
  id: string;
  workspace_id: string;
  routine_id: string;
  kind: string;
  label: string | null;
  enabled: number; // SQLite stores booleans as integers
  cron_expression: string | null;
  timezone: string | null;
  next_run_at: number | null;
  last_fired_at: number | null;
  public_id: string | null;
  secret_signing_mode: string | null;
  replay_window_sec: number | null;
  last_rotated_at: number | null;
  last_result: string | null;
  created_by_agent_id: string | null;
  created_by_user_id: string | null;
  updated_by_agent_id: string | null;
  updated_by_user_id: string | null;
  created_at: number;
  updated_at: number;
};

type RoutineRunRow = {
  id: string;
  workspace_id: string;
  routine_id: string;
  trigger_id: string | null;
  source: string;
  status: string;
  triggered_at: number;
  idempotency_key: string | null;
  trigger_payload_json: string | null; // JSON text
  linked_issue_id: string | null;
  coalesced_into_run_id: string | null;
  failure_reason: string | null;
  completed_at: number | null;
  created_at: number;
  updated_at: number;
};

// ── Converters ────────────────────────────────────────────────────────────────

function rowToRoutine(row: RoutineRow): Routine {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    goalId: row.goal_id,
    parentIssueId: row.parent_issue_id,
    title: row.title,
    description: row.description,
    assigneeAgentId: row.assignee_agent_id,
    priority: row.priority,
    status: row.status,
    concurrencyPolicy: row.concurrency_policy,
    catchUpPolicy: row.catch_up_policy,
    createdByAgentId: row.created_by_agent_id,
    createdByUserId: row.created_by_user_id,
    updatedByAgentId: row.updated_by_agent_id,
    updatedByUserId: row.updated_by_user_id,
    lastTriggeredAt: row.last_triggered_at,
    lastEnqueuedAt: row.last_enqueued_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToRoutineTrigger(row: RoutineTriggerRow): RoutineTrigger {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    routineId: row.routine_id,
    kind: row.kind,
    label: row.label,
    enabled: row.enabled === 1,
    cronExpression: row.cron_expression,
    timezone: row.timezone,
    nextRunAt: row.next_run_at,
    lastFiredAt: row.last_fired_at,
    publicId: row.public_id,
    secretSigningMode: row.secret_signing_mode,
    replayWindowSec: row.replay_window_sec,
    lastRotatedAt: row.last_rotated_at,
    lastResult: row.last_result,
    createdByAgentId: row.created_by_agent_id,
    createdByUserId: row.created_by_user_id,
    updatedByAgentId: row.updated_by_agent_id,
    updatedByUserId: row.updated_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToRoutineRun(row: RoutineRunRow): RoutineRun {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    routineId: row.routine_id,
    triggerId: row.trigger_id,
    source: row.source,
    status: row.status,
    triggeredAt: row.triggered_at,
    idempotencyKey: row.idempotency_key,
    triggerPayload: row.trigger_payload_json ? (JSON.parse(row.trigger_payload_json) as Record<string, unknown>) : null,
    linkedIssueId: row.linked_issue_id,
    coalescedIntoRunId: row.coalesced_into_run_id,
    failureReason: row.failure_reason,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── Routines CRUD ─────────────────────────────────────────────────────────────

export function createRoutine(params: {
  workspaceId: string;
  title: string;
  assigneeAgentId: string;
  description?: string;
  projectId?: string;
  goalId?: string;
  parentIssueId?: string;
  priority?: string;
  status?: string;
  concurrencyPolicy?: string;
  catchUpPolicy?: string;
  createdByAgentId?: string;
  createdByUserId?: string;
}): Routine {
  const db = getStateDb();
  const id = randomUUID();
  const now = Math.floor(Date.now() / 1000);

  db.prepare(`
    INSERT INTO op1_routines (
      id, workspace_id, project_id, goal_id, parent_issue_id, title, description,
      assignee_agent_id, priority, status, concurrency_policy, catch_up_policy,
      created_by_agent_id, created_by_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    params.workspaceId,
    params.projectId ?? null,
    params.goalId ?? null,
    params.parentIssueId ?? null,
    params.title,
    params.description ?? null,
    params.assigneeAgentId,
    params.priority ?? "medium",
    params.status ?? "active",
    params.concurrencyPolicy ?? "coalesce_if_active",
    params.catchUpPolicy ?? "skip_missed",
    params.createdByAgentId ?? null,
    params.createdByUserId ?? null,
    now,
    now,
  );

  return getRoutine(id)!;
}

export function getRoutine(id: string): Routine | null {
  const db = getStateDb();
  const row = db.prepare("SELECT * FROM op1_routines WHERE id = ?").get(id);
  return row ? rowToRoutine(row as unknown as RoutineRow) : null;
}

export function listRoutines(workspaceId: string): Routine[] {
  const db = getStateDb();
  const rows = db
    .prepare("SELECT * FROM op1_routines WHERE workspace_id = ? ORDER BY updated_at DESC")
    .all(workspaceId);
  return (rows as unknown as RoutineRow[]).map(rowToRoutine);
}

export function listRoutinesWithDetails(workspaceId: string): RoutineListItem[] {
  const routines = listRoutines(workspaceId);
  return routines.map((r) => {
    const triggers = listRoutineTriggers(r.id).map((t) => ({
      id: t.id,
      kind: t.kind,
      label: t.label,
      enabled: t.enabled,
      nextRunAt: t.nextRunAt,
      lastFiredAt: t.lastFiredAt,
      lastResult: t.lastResult,
    }));
    const runs = listRoutineRuns(r.id, { limit: 1 });
    return { ...r, triggers, lastRun: runs[0] ?? null };
  });
}

export function updateRoutine(
  id: string,
  updates: {
    title?: string;
    description?: string | null;
    assigneeAgentId?: string;
    projectId?: string | null;
    goalId?: string | null;
    parentIssueId?: string | null;
    priority?: string;
    status?: string;
    concurrencyPolicy?: string;
    catchUpPolicy?: string;
    updatedByAgentId?: string | null;
    updatedByUserId?: string | null;
    lastTriggeredAt?: number | null;
    lastEnqueuedAt?: number | null;
  },
): Routine {
  const db = getStateDb();
  const existing = getRoutine(id);
  if (!existing) throw new Error(`Routine not found: ${id}`);

  const now = Math.floor(Date.now() / 1000);
  const sets: string[] = ["updated_at = ?"];
  const params: Array<string | number | bigint | null> = [now];

  if (updates.title !== undefined) { sets.push("title = ?"); params.push(updates.title); }
  if (updates.description !== undefined) { sets.push("description = ?"); params.push(updates.description); }
  if (updates.assigneeAgentId !== undefined) { sets.push("assignee_agent_id = ?"); params.push(updates.assigneeAgentId); }
  if (updates.projectId !== undefined) { sets.push("project_id = ?"); params.push(updates.projectId); }
  if (updates.goalId !== undefined) { sets.push("goal_id = ?"); params.push(updates.goalId); }
  if (updates.parentIssueId !== undefined) { sets.push("parent_issue_id = ?"); params.push(updates.parentIssueId); }
  if (updates.priority !== undefined) { sets.push("priority = ?"); params.push(updates.priority); }
  if (updates.status !== undefined) { sets.push("status = ?"); params.push(updates.status); }
  if (updates.concurrencyPolicy !== undefined) { sets.push("concurrency_policy = ?"); params.push(updates.concurrencyPolicy); }
  if (updates.catchUpPolicy !== undefined) { sets.push("catch_up_policy = ?"); params.push(updates.catchUpPolicy); }
  if (updates.updatedByAgentId !== undefined) { sets.push("updated_by_agent_id = ?"); params.push(updates.updatedByAgentId); }
  if (updates.updatedByUserId !== undefined) { sets.push("updated_by_user_id = ?"); params.push(updates.updatedByUserId); }
  if (updates.lastTriggeredAt !== undefined) { sets.push("last_triggered_at = ?"); params.push(updates.lastTriggeredAt); }
  if (updates.lastEnqueuedAt !== undefined) { sets.push("last_enqueued_at = ?"); params.push(updates.lastEnqueuedAt); }

  params.push(id);
  db.prepare(`UPDATE op1_routines SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return getRoutine(id)!;
}

export function deleteRoutine(id: string): void {
  const db = getStateDb();
  db.prepare("DELETE FROM op1_routines WHERE id = ?").run(id);
}

// ── Routine Triggers CRUD ─────────────────────────────────────────────────────

export function createRoutineTrigger(params: {
  workspaceId: string;
  routineId: string;
  kind: string;
  label?: string;
  enabled?: boolean;
  cronExpression?: string;
  timezone?: string;
  nextRunAt?: number;
  publicId?: string;
  secretSigningMode?: string;
  replayWindowSec?: number;
  createdByAgentId?: string;
  createdByUserId?: string;
}): RoutineTrigger {
  const db = getStateDb();
  const id = randomUUID();
  const now = Math.floor(Date.now() / 1000);

  db.prepare(`
    INSERT INTO op1_routine_triggers (
      id, workspace_id, routine_id, kind, label, enabled, cron_expression, timezone,
      next_run_at, public_id, secret_signing_mode, replay_window_sec,
      created_by_agent_id, created_by_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    params.workspaceId,
    params.routineId,
    params.kind,
    params.label ?? null,
    params.enabled !== false ? 1 : 0,
    params.cronExpression ?? null,
    params.timezone ?? null,
    params.nextRunAt ?? null,
    params.publicId ?? null,
    params.secretSigningMode ?? null,
    params.replayWindowSec ?? null,
    params.createdByAgentId ?? null,
    params.createdByUserId ?? null,
    now,
    now,
  );

  return getRoutineTrigger(id)!;
}

export function getRoutineTrigger(id: string): RoutineTrigger | null {
  const db = getStateDb();
  const row = db.prepare("SELECT * FROM op1_routine_triggers WHERE id = ?").get(id);
  return row ? rowToRoutineTrigger(row as unknown as RoutineTriggerRow) : null;
}

export function listRoutineTriggers(routineId: string): RoutineTrigger[] {
  const db = getStateDb();
  const rows = db
    .prepare("SELECT * FROM op1_routine_triggers WHERE routine_id = ? ORDER BY created_at ASC")
    .all(routineId);
  return (rows as unknown as RoutineTriggerRow[]).map(rowToRoutineTrigger);
}

export function updateRoutineTrigger(
  id: string,
  updates: {
    label?: string | null;
    enabled?: boolean;
    cronExpression?: string | null;
    timezone?: string | null;
    nextRunAt?: number | null;
    lastFiredAt?: number | null;
    lastResult?: string | null;
    lastRotatedAt?: number | null;
    updatedByAgentId?: string | null;
    updatedByUserId?: string | null;
  },
): RoutineTrigger {
  const db = getStateDb();
  const existing = getRoutineTrigger(id);
  if (!existing) throw new Error(`RoutineTrigger not found: ${id}`);

  const now = Math.floor(Date.now() / 1000);
  const sets: string[] = ["updated_at = ?"];
  const params: Array<string | number | bigint | null> = [now];

  if (updates.label !== undefined) { sets.push("label = ?"); params.push(updates.label); }
  if (updates.enabled !== undefined) { sets.push("enabled = ?"); params.push(updates.enabled ? 1 : 0); }
  if (updates.cronExpression !== undefined) { sets.push("cron_expression = ?"); params.push(updates.cronExpression); }
  if (updates.timezone !== undefined) { sets.push("timezone = ?"); params.push(updates.timezone); }
  if (updates.nextRunAt !== undefined) { sets.push("next_run_at = ?"); params.push(updates.nextRunAt); }
  if (updates.lastFiredAt !== undefined) { sets.push("last_fired_at = ?"); params.push(updates.lastFiredAt); }
  if (updates.lastResult !== undefined) { sets.push("last_result = ?"); params.push(updates.lastResult); }
  if (updates.lastRotatedAt !== undefined) { sets.push("last_rotated_at = ?"); params.push(updates.lastRotatedAt); }
  if (updates.updatedByAgentId !== undefined) { sets.push("updated_by_agent_id = ?"); params.push(updates.updatedByAgentId); }
  if (updates.updatedByUserId !== undefined) { sets.push("updated_by_user_id = ?"); params.push(updates.updatedByUserId); }

  params.push(id);
  db.prepare(`UPDATE op1_routine_triggers SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return getRoutineTrigger(id)!;
}

export function deleteRoutineTrigger(id: string): void {
  const db = getStateDb();
  db.prepare("DELETE FROM op1_routine_triggers WHERE id = ?").run(id);
}

// ── Routine Runs CRUD ─────────────────────────────────────────────────────────

export function createRoutineRun(params: {
  workspaceId: string;
  routineId: string;
  source: string;
  triggerId?: string;
  triggeredAt?: number;
  idempotencyKey?: string;
  triggerPayload?: Record<string, unknown>;
  linkedIssueId?: string;
  status?: string;
}): RoutineRun {
  const db = getStateDb();
  const id = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const triggeredAt = params.triggeredAt ?? now;

  db.prepare(`
    INSERT INTO op1_routine_runs (
      id, workspace_id, routine_id, trigger_id, source, status, triggered_at,
      idempotency_key, trigger_payload_json, linked_issue_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    params.workspaceId,
    params.routineId,
    params.triggerId ?? null,
    params.source,
    params.status ?? "received",
    triggeredAt,
    params.idempotencyKey ?? null,
    params.triggerPayload ? JSON.stringify(params.triggerPayload) : null,
    params.linkedIssueId ?? null,
    now,
    now,
  );

  return getRoutineRun(id)!;
}

export function getRoutineRun(id: string): RoutineRun | null {
  const db = getStateDb();
  const row = db.prepare("SELECT * FROM op1_routine_runs WHERE id = ?").get(id);
  return row ? rowToRoutineRun(row as unknown as RoutineRunRow) : null;
}

export function listRoutineRuns(
  routineId: string,
  opts?: { limit?: number; status?: string },
): RoutineRun[] {
  const db = getStateDb();
  let query = "SELECT * FROM op1_routine_runs WHERE routine_id = ?";
  const params: Array<string | number | bigint | null> = [routineId];

  if (opts?.status) {
    query += " AND status = ?";
    params.push(opts.status);
  }

  query += " ORDER BY triggered_at DESC";

  if (opts?.limit) {
    query += " LIMIT ?";
    params.push(opts.limit);
  }

  const rows = db.prepare(query).all(...params);
  return (rows as unknown as RoutineRunRow[]).map(rowToRoutineRun);
}

export function updateRoutineRun(
  id: string,
  updates: {
    status?: string;
    linkedIssueId?: string | null;
    coalescedIntoRunId?: string | null;
    failureReason?: string | null;
    completedAt?: number | null;
  },
): RoutineRun {
  const db = getStateDb();
  const existing = getRoutineRun(id);
  if (!existing) throw new Error(`RoutineRun not found: ${id}`);

  const now = Math.floor(Date.now() / 1000);
  const sets: string[] = ["updated_at = ?"];
  const params: Array<string | number | bigint | null> = [now];

  if (updates.status !== undefined) { sets.push("status = ?"); params.push(updates.status); }
  if (updates.linkedIssueId !== undefined) { sets.push("linked_issue_id = ?"); params.push(updates.linkedIssueId); }
  if (updates.coalescedIntoRunId !== undefined) { sets.push("coalesced_into_run_id = ?"); params.push(updates.coalescedIntoRunId); }
  if (updates.failureReason !== undefined) { sets.push("failure_reason = ?"); params.push(updates.failureReason); }
  if (updates.completedAt !== undefined) { sets.push("completed_at = ?"); params.push(updates.completedAt); }

  params.push(id);
  db.prepare(`UPDATE op1_routine_runs SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return getRoutineRun(id)!;
}

// ── Test DB injection ─────────────────────────────────────────────────────────

// Use these only in tests — see goal-store.test.ts for the pattern.
// Production code always calls getStateDb() from infra.
export type { RoutineRow, RoutineTriggerRow, RoutineRunRow };
