/**
 * OpenClaw AGI - Intent Engine
 *
 * Tracks goals, sub-goals, plans, and execution state.
 * Ensures task completion with dependency management and cascading status.
 *
 * Uses the shared DatabaseManager — never creates its own DB connection.
 *
 * @module agi/intent
 */

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getDatabase, jsonToSql, sqlToJson, sqlToDate } from "../shared/db.js";

const log = createSubsystemLogger("agi:intent");

// ============================================================================
// TYPES
// ============================================================================

export type IntentType =
  | "implement"
  | "fix"
  | "research"
  | "review"
  | "refactor"
  | "deploy"
  | "test"
  | "other";

export type IntentPriority = "critical" | "high" | "medium" | "low";

export type IntentStatus = "pending" | "active" | "blocked" | "completed" | "failed" | "abandoned";

export type PlanStatus = "active" | "paused" | "completed" | "failed" | "abandoned";

export type StepStatus = "pending" | "in_progress" | "completed" | "blocked" | "failed" | "skipped";

export interface Intent {
  id: string;
  agentId: string;
  parentId?: string;
  type: IntentType;
  description: string;
  priority: IntentPriority;
  status: IntentStatus;
  estimatedTime: number; // minutes
  dependencies: string[];
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  blockedReason?: string;
  escalationReason?: string;
  metadata?: Record<string, unknown>;
}

export interface Plan {
  id: string;
  intentId: string;
  status: PlanStatus;
  currentStep: number;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

export interface PlanStep {
  id: string;
  planId: string;
  stepIndex: number;
  description: string;
  status: StepStatus;
  estimatedTime: number;
  dependencies: string[];
  blockedReason?: string;
  startedAt?: Date;
  completedAt?: Date;
  result?: unknown;
  error?: string;
}

export interface Checkpoint {
  id: string;
  intentId: string;
  planId?: string;
  stepId?: string;
  timestamp: Date;
  state: Record<string, unknown>;
}

export interface IntentMetrics {
  totalIntents: number;
  completed: number;
  failed: number;
  inProgress: number;
  blocked: number;
  averageCompletionTime: number; // minutes
  successRate: number; // 0-1
}

// ============================================================================
// INTENT ENGINE
// ============================================================================

export class IntentEngine {
  private db: DatabaseSync;
  private agentId: string;

  constructor(agentId: string, dbPath?: string) {
    this.agentId = agentId;
    this.db = getDatabase(agentId, dbPath);
    log.info(`IntentEngine initialized for agent: ${agentId}`);
  }

  // ============================================================================
  // INTENT CRUD
  // ============================================================================

  /** Create a new intent (top-level or sub-intent) */
  createIntent(config: {
    type: IntentType;
    description: string;
    priority: IntentPriority;
    parentId?: string;
    estimatedTime?: number;
    dependencies?: string[];
    metadata?: Record<string, unknown>;
  }): Intent {
    const id = randomUUID();
    const now = new Date().toISOString();

    // Validate dependencies exist
    if (config.dependencies?.length) {
      this.validateDependencies(config.dependencies);
    }

    // Validate parent exists
    if (config.parentId) {
      const parent = this.getIntent(config.parentId);
      if (!parent) {
        throw new Error(`Parent intent not found: ${config.parentId}`);
      }
    }

    const intent: Intent = {
      id,
      agentId: this.agentId,
      parentId: config.parentId,
      type: config.type,
      description: config.description,
      priority: config.priority,
      status: "pending",
      estimatedTime: config.estimatedTime || 30,
      dependencies: config.dependencies || [],
      createdAt: new Date(now),
      metadata: config.metadata,
    };

    this.db
      .prepare(
        `INSERT INTO intents (
        id, agent_id, parent_id, type, description, priority, status,
        estimated_time, dependencies, created_at, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        this.agentId,
        config.parentId || null,
        config.type,
        config.description,
        config.priority,
        "pending",
        intent.estimatedTime,
        jsonToSql(intent.dependencies),
        now,
        jsonToSql(config.metadata),
      );

    log.info(`Created intent: ${config.description} [${config.priority}] (${id})`);
    return intent;
  }

  /** Get an intent by ID */
  getIntent(intentId: string): Intent | null {
    const row = this.db.prepare("SELECT * FROM intents WHERE id = ?").get(intentId) as
      | Record<string, unknown>
      | undefined;

    return row ? this.rowToIntent(row) : null;
  }

  /** List intents with optional filters */
  listIntents(filters?: {
    status?: IntentStatus;
    type?: IntentType;
    priority?: IntentPriority;
    parentId?: string | null;
    limit?: number;
  }): Intent[] {
    let sql = "SELECT * FROM intents WHERE agent_id = ?";
    const params: (string | number | null)[] = [this.agentId];

    if (filters?.status) {
      sql += " AND status = ?";
      params.push(filters.status);
    }
    if (filters?.type) {
      sql += " AND type = ?";
      params.push(filters.type);
    }
    if (filters?.priority) {
      sql += " AND priority = ?";
      params.push(filters.priority);
    }
    if (filters?.parentId !== undefined) {
      if (filters.parentId === null) {
        sql += " AND parent_id IS NULL";
      } else {
        sql += " AND parent_id = ?";
        params.push(filters.parentId);
      }
    }

    sql += " ORDER BY created_at DESC";
    if (filters?.limit) {
      sql += ` LIMIT ${filters.limit}`;
    }

    const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToIntent(row));
  }

  /** Get sub-intents for a parent */
  getSubIntents(parentId: string): Intent[] {
    return this.listIntents({ parentId });
  }

  // ============================================================================
  // INTENT LIFECYCLE
  // ============================================================================

  /** Start working on an intent */
  startIntent(intentId: string): Intent {
    const intent = this.getIntent(intentId);
    if (!intent) {
      throw new Error(`Intent not found: ${intentId}`);
    }

    // Check dependencies are completed
    for (const depId of intent.dependencies) {
      const dep = this.getIntent(depId);
      if (dep && dep.status !== "completed") {
        throw new Error(`Cannot start intent: dependency "${dep.description}" is ${dep.status}`);
      }
    }

    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE intents SET status = ?, started_at = ? WHERE id = ?")
      .run("active", now, intentId);

    log.info(`Started intent: ${intent.description}`);
    return { ...intent, status: "active", startedAt: new Date(now) };
  }

  /** Complete an intent */
  completeIntent(intentId: string): Intent {
    const intent = this.getIntent(intentId);
    if (!intent) {
      throw new Error(`Intent not found: ${intentId}`);
    }

    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE intents SET status = ?, completed_at = ? WHERE id = ?")
      .run("completed", now, intentId);

    log.info(`Completed intent: ${intent.description}`);

    // Cascade: check if parent can be completed
    if (intent.parentId) {
      this.checkParentCompletion(intent.parentId);
    }

    return { ...intent, status: "completed", completedAt: new Date(now) };
  }

  /** Block an intent with a reason */
  blockIntent(intentId: string, reason: string): Intent {
    const intent = this.getIntent(intentId);
    if (!intent) {
      throw new Error(`Intent not found: ${intentId}`);
    }

    this.db
      .prepare("UPDATE intents SET status = ?, blocked_reason = ? WHERE id = ?")
      .run("blocked", reason, intentId);

    log.warn(`Blocked intent: ${intent.description} — ${reason}`);
    return { ...intent, status: "blocked", blockedReason: reason };
  }

  /** Fail an intent */
  failIntent(intentId: string, error: string): Intent {
    const intent = this.getIntent(intentId);
    if (!intent) {
      throw new Error(`Intent not found: ${intentId}`);
    }

    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE intents SET status = ?, completed_at = ?, escalation_reason = ? WHERE id = ?",
      )
      .run("failed", now, error, intentId);

    log.error(`Failed intent: ${intent.description} — ${error}`);
    return {
      ...intent,
      status: "failed",
      completedAt: new Date(now),
      escalationReason: error,
    };
  }

  /** Abandon an intent */
  abandonIntent(intentId: string, reason?: string): Intent {
    const intent = this.getIntent(intentId);
    if (!intent) {
      throw new Error(`Intent not found: ${intentId}`);
    }

    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE intents SET status = ?, completed_at = ?, escalation_reason = ? WHERE id = ?",
      )
      .run("abandoned", now, reason || null, intentId);

    // Cascade: abandon sub-intents
    const subIntents = this.getSubIntents(intentId);
    for (const sub of subIntents) {
      if (sub.status === "pending" || sub.status === "active") {
        this.abandonIntent(sub.id, "Parent abandoned");
      }
    }

    log.info(`Abandoned intent: ${intent.description}`);
    return { ...intent, status: "abandoned", completedAt: new Date(now) };
  }

  // ============================================================================
  // PLAN MANAGEMENT
  // ============================================================================

  /** Create a plan for an intent */
  createPlan(
    intentId: string,
    steps: Array<{
      description: string;
      estimatedTime?: number;
      dependencies?: string[];
    }>,
  ): Plan {
    const intent = this.getIntent(intentId);
    if (!intent) {
      throw new Error(`Intent not found: ${intentId}`);
    }

    const planId = randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO plans (id, intent_id, status, current_step, created_at, started_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(planId, intentId, "active", 0, now, now);

    const stepStmt = this.db.prepare(
      `INSERT INTO plan_steps (id, plan_id, step_index, description, status, estimated_time, dependencies)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      stepStmt.run(
        randomUUID(),
        planId,
        i,
        step.description,
        i === 0 ? "in_progress" : "pending",
        step.estimatedTime || 10,
        jsonToSql(step.dependencies || []),
      );
    }

    log.info(`Created plan for intent "${intent.description}" with ${steps.length} steps`);
    return {
      id: planId,
      intentId,
      status: "active",
      currentStep: 0,
      createdAt: new Date(now),
      startedAt: new Date(now),
    };
  }

  /** Get a plan by ID */
  getPlan(planId: string): Plan | null {
    const row = this.db.prepare("SELECT * FROM plans WHERE id = ?").get(planId) as
      | Record<string, unknown>
      | undefined;

    return row ? this.rowToPlan(row) : null;
  }

  /** Get steps for a plan */
  getPlanSteps(planId: string): PlanStep[] {
    const rows = this.db
      .prepare("SELECT * FROM plan_steps WHERE plan_id = ? ORDER BY step_index")
      .all(planId) as Array<Record<string, unknown>>;

    return rows.map((row) => this.rowToStep(row));
  }

  /** Complete current step and advance plan */
  advancePlan(planId: string, result?: unknown): PlanStep | null {
    const plan = this.getPlan(planId);
    if (!plan) {
      throw new Error(`Plan not found: ${planId}`);
    }

    const steps = this.getPlanSteps(planId);
    const current = steps[plan.currentStep];
    if (!current) {
      return null;
    }

    const now = new Date().toISOString();

    // Complete current step
    this.db
      .prepare("UPDATE plan_steps SET status = ?, completed_at = ?, result = ? WHERE id = ?")
      .run("completed", now, jsonToSql(result), current.id);

    // Advance to next step
    const nextIndex = plan.currentStep + 1;
    if (nextIndex < steps.length) {
      const nextStep = steps[nextIndex];
      this.db
        .prepare("UPDATE plan_steps SET status = ?, started_at = ? WHERE id = ?")
        .run("in_progress", now, nextStep.id);
      this.db.prepare("UPDATE plans SET current_step = ? WHERE id = ?").run(nextIndex, planId);

      log.info(`Plan advanced to step ${nextIndex + 1}/${steps.length}: ${nextStep.description}`);
      return { ...nextStep, status: "in_progress", startedAt: new Date(now) };
    }

    // All steps done
    this.db
      .prepare("UPDATE plans SET status = ?, completed_at = ? WHERE id = ?")
      .run("completed", now, planId);
    log.info("Plan completed");
    return null;
  }

  /** Fail a step */
  failStep(planId: string, stepId: string, error: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE plan_steps SET status = ?, completed_at = ?, error = ? WHERE id = ?")
      .run("failed", now, error, stepId);
    this.db
      .prepare("UPDATE plans SET status = ?, completed_at = ? WHERE id = ?")
      .run("failed", now, planId);
    log.error(`Step failed in plan ${planId}: ${error}`);
  }

  // ============================================================================
  // CHECKPOINTS
  // ============================================================================

  /** Save a checkpoint */
  saveCheckpoint(
    intentId: string,
    state: Record<string, unknown>,
    planId?: string,
    stepId?: string,
  ): Checkpoint {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO checkpoints (id, intent_id, plan_id, step_id, timestamp, state)
       VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, intentId, planId || null, stepId || null, now, jsonToSql(state));

    log.debug(`Checkpoint saved for intent: ${intentId}`);
    return {
      id,
      intentId,
      planId,
      stepId,
      timestamp: new Date(now),
      state,
    };
  }

  /** Load latest checkpoint for an intent */
  loadCheckpoint(intentId: string): Checkpoint | null {
    const row = this.db
      .prepare("SELECT * FROM checkpoints WHERE intent_id = ? ORDER BY timestamp DESC LIMIT 1")
      .get(intentId) as Record<string, unknown> | undefined;

    if (!row) {
      return null;
    }
    return {
      id: row.id as string,
      intentId: row.intent_id as string,
      planId: (row.plan_id as string) || undefined,
      stepId: (row.step_id as string) || undefined,
      timestamp: new Date(row.timestamp as string),
      state: sqlToJson<Record<string, unknown>>(row.state as string) || {},
    };
  }

  // ============================================================================
  // METRICS
  // ============================================================================

  /** Get intent metrics for the agent */
  getMetrics(): IntentMetrics {
    type CountResult = { count: number };
    type AvgResult = { avg_time: number | null };

    const total = this.db
      .prepare("SELECT COUNT(*) as count FROM intents WHERE agent_id = ?")
      .get(this.agentId) as CountResult;
    const completed = this.db
      .prepare("SELECT COUNT(*) as count FROM intents WHERE agent_id = ? AND status = ?")
      .get(this.agentId, "completed") as CountResult;
    const failed = this.db
      .prepare("SELECT COUNT(*) as count FROM intents WHERE agent_id = ? AND status = ?")
      .get(this.agentId, "failed") as CountResult;
    const inProgress = this.db
      .prepare("SELECT COUNT(*) as count FROM intents WHERE agent_id = ? AND status = ?")
      .get(this.agentId, "active") as CountResult;
    const blocked = this.db
      .prepare("SELECT COUNT(*) as count FROM intents WHERE agent_id = ? AND status = ?")
      .get(this.agentId, "blocked") as CountResult;

    const avgTime = this.db
      .prepare(
        `SELECT AVG(
        (julianday(completed_at) - julianday(started_at)) * 24 * 60
      ) as avg_time FROM intents
      WHERE agent_id = ? AND status = 'completed' AND started_at IS NOT NULL`,
      )
      .get(this.agentId) as AvgResult;

    const totalCount = total.count;
    const completedCount = completed.count;

    return {
      totalIntents: totalCount,
      completed: completedCount,
      failed: failed.count,
      inProgress: inProgress.count,
      blocked: blocked.count,
      averageCompletionTime: avgTime.avg_time || 0,
      successRate: totalCount > 0 ? completedCount / totalCount : 0,
    };
  }

  // ============================================================================
  // PRIVATE HELPERS
  // ============================================================================

  private validateDependencies(depIds: string[]): void {
    for (const depId of depIds) {
      const exists = this.db.prepare("SELECT id FROM intents WHERE id = ?").get(depId);
      if (!exists) {
        throw new Error(`Dependency intent not found: ${depId}`);
      }
    }
  }

  private checkParentCompletion(parentId: string): void {
    const siblings = this.getSubIntents(parentId);
    const allDone = siblings.every(
      (s) => s.status === "completed" || s.status === "abandoned" || s.status === "failed",
    );
    if (allDone && siblings.length > 0) {
      const allCompleted = siblings.every(
        (s) => s.status === "completed" || s.status === "abandoned",
      );
      if (allCompleted) {
        this.completeIntent(parentId);
      }
    }
  }

  private rowToIntent(row: Record<string, unknown>): Intent {
    return {
      id: row.id as string,
      agentId: row.agent_id as string,
      parentId: (row.parent_id as string) || undefined,
      type: row.type as IntentType,
      description: row.description as string,
      priority: row.priority as IntentPriority,
      status: row.status as IntentStatus,
      estimatedTime: row.estimated_time as number,
      dependencies: sqlToJson<string[]>(row.dependencies as string) || [],
      createdAt: new Date(row.created_at as string),
      startedAt: sqlToDate(row.started_at as string | null),
      completedAt: sqlToDate(row.completed_at as string | null),
      blockedReason: (row.blocked_reason as string) || undefined,
      escalationReason: (row.escalation_reason as string) || undefined,
      metadata: sqlToJson<Record<string, unknown>>(row.metadata as string | null),
    };
  }

  private rowToPlan(row: Record<string, unknown>): Plan {
    return {
      id: row.id as string,
      intentId: row.intent_id as string,
      status: row.status as PlanStatus,
      currentStep: row.current_step as number,
      createdAt: new Date(row.created_at as string),
      startedAt: sqlToDate(row.started_at as string | null),
      completedAt: sqlToDate(row.completed_at as string | null),
    };
  }

  private rowToStep(row: Record<string, unknown>): PlanStep {
    return {
      id: row.id as string,
      planId: row.plan_id as string,
      stepIndex: row.step_index as number,
      description: row.description as string,
      status: row.status as StepStatus,
      estimatedTime: row.estimated_time as number,
      dependencies: sqlToJson<string[]>(row.dependencies as string) || [],
      blockedReason: (row.blocked_reason as string) || undefined,
      startedAt: sqlToDate(row.started_at as string | null),
      completedAt: sqlToDate(row.completed_at as string | null),
      result: sqlToJson(row.result as string | null),
      error: (row.error as string) || undefined,
    };
  }
}

// ============================================================================
// FACTORY
// ============================================================================

const intentEngines = new Map<string, IntentEngine>();

export function getIntentEngine(agentId: string): IntentEngine {
  if (!intentEngines.has(agentId)) {
    intentEngines.set(agentId, new IntentEngine(agentId));
  }
  return intentEngines.get(agentId)!;
}
