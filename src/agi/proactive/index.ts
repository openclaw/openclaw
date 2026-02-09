/**
 * OpenClaw AGI - Proactive Module
 *
 * Enables agents to take self-initiated actions based on configurable
 * trigger rules and guard conditions. Examples:
 *
 * - "If no user message for 5 min during active task, send a status update"
 * - "If a test file is edited, automatically run tests"
 * - "If a PR is merged, update the changelog"
 *
 * Rules are persisted and evaluated against incoming trigger events.
 * Cooldowns prevent rule storm (same rule firing too frequently).
 *
 * Uses the shared DatabaseManager — never creates its own DB connection.
 *
 * @module agi/proactive
 */

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getDatabase, jsonToSql, sqlToJson, sqlToBoolean, booleanToSql } from "../shared/db.js";

const log = createSubsystemLogger("agi:proactive");

// ============================================================================
// TYPES
// ============================================================================

export type TriggerType =
  | "idle" // Agent idle for N seconds
  | "file_change" // File in workspace changed
  | "cron" // Cron schedule matched
  | "event" // System event received
  | "tool_result" // A tool returned a specific pattern
  | "session_start" // New session started
  | "session_end" // Session ended
  | "error" // Error occurred
  | "custom"; // Custom trigger from hook/skill

export type ActionType =
  | "send_message" // Send a message to the user
  | "run_tool" // Execute a tool
  | "create_intent" // Create a new intent
  | "system_event" // Enqueue a system event
  | "webhook" // Call an external webhook
  | "log"; // Just log the trigger

export type RulePriority = "critical" | "high" | "medium" | "low";

export interface ProactiveRule {
  id: string;
  agentId: string;
  triggerType: TriggerType;
  triggerCondition: Record<string, unknown>;
  actionType: ActionType;
  actionPayload: Record<string, unknown>;
  priority: RulePriority;
  enabled: boolean;
  cooldownMs: number;
  lastFiredAt?: Date;
  fireCount: number;
  maxFires: number; // 0 = unlimited
  guardExpression?: string; // Simple guard: "mode == 'coding'" etc.
  createdAt: Date;
  updatedAt: Date;
}

export interface TriggerEvent {
  type: TriggerType;
  data: Record<string, unknown>;
  timestamp: Date;
}

export interface FiredAction {
  ruleId: string;
  actionType: ActionType;
  actionPayload: Record<string, unknown>;
  triggerData: Record<string, unknown>;
  timestamp: Date;
}

export interface ProactiveLogEntry {
  id: string;
  ruleId: string;
  agentId: string;
  firedAt: Date;
  triggerData?: Record<string, unknown>;
  actionResult?: unknown;
  success: boolean;
  error?: string;
}

// ============================================================================
// PROACTIVE MANAGER
// ============================================================================

export class ProactiveManager {
  private db: DatabaseSync;
  private agentId: string;

  /** Listeners that receive fired actions for execution */
  private actionHandlers: Set<(action: FiredAction) => Promise<void>> = new Set();

  constructor(agentId: string, dbPath?: string) {
    this.agentId = agentId;
    this.db = getDatabase(agentId, dbPath);
    log.info(`ProactiveManager initialized for agent: ${agentId}`);
  }

  // ============================================================================
  // RULE CRUD
  // ============================================================================

  /** Create a new proactive rule */
  createRule(config: {
    triggerType: TriggerType;
    triggerCondition: Record<string, unknown>;
    actionType: ActionType;
    actionPayload: Record<string, unknown>;
    priority?: RulePriority;
    cooldownMs?: number;
    maxFires?: number;
    guardExpression?: string;
  }): ProactiveRule {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO proactive_rules (
        id, agent_id, trigger_type, trigger_condition, action_type, action_payload,
        priority, enabled, cooldown_ms, last_fired_at, fire_count, max_fires,
        guard_expression, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        this.agentId,
        config.triggerType,
        JSON.stringify(config.triggerCondition),
        config.actionType,
        JSON.stringify(config.actionPayload),
        config.priority || "medium",
        1, // enabled by default
        config.cooldownMs || 300_000, // 5 min default
        null,
        0,
        config.maxFires || 0,
        config.guardExpression || null,
        now,
        now,
      );

    log.info(`Created proactive rule: ${config.triggerType} → ${config.actionType} (${id})`);
    return this.getRule(id)!;
  }

  /** Get a rule by ID */
  getRule(ruleId: string): ProactiveRule | null {
    const row = this.db.prepare("SELECT * FROM proactive_rules WHERE id = ?").get(ruleId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.rowToRule(row) : null;
  }

  /** List all rules */
  listRules(enabledOnly = false): ProactiveRule[] {
    let sql = "SELECT * FROM proactive_rules WHERE agent_id = ?";
    if (enabledOnly) {
      sql += " AND enabled = 1";
    }
    sql += " ORDER BY priority ASC, created_at DESC";

    const rows = this.db.prepare(sql).all(this.agentId) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToRule(row));
  }

  /** Enable or disable a rule */
  setRuleEnabled(ruleId: string, enabled: boolean): void {
    this.db
      .prepare("UPDATE proactive_rules SET enabled = ?, updated_at = ? WHERE id = ?")
      .run(booleanToSql(enabled), new Date().toISOString(), ruleId);
    log.info(`Rule ${ruleId} ${enabled ? "enabled" : "disabled"}`);
  }

  /** Update a rule */
  updateRule(
    ruleId: string,
    updates: Partial<{
      triggerCondition: Record<string, unknown>;
      actionPayload: Record<string, unknown>;
      priority: RulePriority;
      cooldownMs: number;
      maxFires: number;
      guardExpression: string;
    }>,
  ): ProactiveRule | null {
    const now = new Date().toISOString();
    const parts: string[] = ["updated_at = ?"];
    const params: (string | number | null)[] = [now];

    if (updates.triggerCondition !== undefined) {
      parts.push("trigger_condition = ?");
      params.push(JSON.stringify(updates.triggerCondition));
    }
    if (updates.actionPayload !== undefined) {
      parts.push("action_payload = ?");
      params.push(JSON.stringify(updates.actionPayload));
    }
    if (updates.priority !== undefined) {
      parts.push("priority = ?");
      params.push(updates.priority);
    }
    if (updates.cooldownMs !== undefined) {
      parts.push("cooldown_ms = ?");
      params.push(updates.cooldownMs);
    }
    if (updates.maxFires !== undefined) {
      parts.push("max_fires = ?");
      params.push(updates.maxFires);
    }
    if (updates.guardExpression !== undefined) {
      parts.push("guard_expression = ?");
      params.push(updates.guardExpression);
    }

    params.push(ruleId);
    this.db.prepare(`UPDATE proactive_rules SET ${parts.join(", ")} WHERE id = ?`).run(...params);

    return this.getRule(ruleId);
  }

  /** Delete a rule */
  deleteRule(ruleId: string): void {
    this.db.prepare("DELETE FROM proactive_rules WHERE id = ?").run(ruleId);
    log.info(`Deleted rule: ${ruleId}`);
  }

  // ============================================================================
  // TRIGGER EVALUATION
  // ============================================================================

  /**
   * Evaluate a trigger event against all active rules.
   *
   * Returns the list of actions that should fire. The caller is responsible
   * for actually executing the actions (via the registered action handlers).
   */
  async evaluate(event: TriggerEvent): Promise<FiredAction[]> {
    const rules = this.listRules(true);
    const actions: FiredAction[] = [];

    for (const rule of rules) {
      if (!this.matchesTrigger(rule, event)) {
        continue;
      }
      if (!this.passesCooldown(rule)) {
        continue;
      }
      if (!this.passesGuard(rule, event)) {
        continue;
      }
      if (!this.passesMaxFires(rule)) {
        continue;
      }

      const action: FiredAction = {
        ruleId: rule.id,
        actionType: rule.actionType,
        actionPayload: rule.actionPayload,
        triggerData: event.data,
        timestamp: new Date(),
      };
      actions.push(action);
      this.recordFiring(rule.id, event.data);
    }

    // Execute registered handlers
    for (const action of actions) {
      for (const handler of this.actionHandlers) {
        try {
          await handler(action);
          this.logAction(action.ruleId, event.data, "ok", true);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          log.error(`Action handler failed for rule ${action.ruleId}: ${errMsg}`);
          this.logAction(action.ruleId, event.data, errMsg, false);
        }
      }
    }

    if (actions.length > 0) {
      log.info(`Trigger ${event.type} matched ${actions.length} rule(s)`);
    }
    return actions;
  }

  /** Register an action handler */
  onAction(handler: (action: FiredAction) => Promise<void>): () => void {
    this.actionHandlers.add(handler);
    return () => this.actionHandlers.delete(handler);
  }

  // ============================================================================
  // TRIGGER MATCHING (private)
  // ============================================================================

  private matchesTrigger(rule: ProactiveRule, event: TriggerEvent): boolean {
    // Type must match
    if (rule.triggerType !== event.type) {
      return false;
    }

    // Condition matching: all keys in triggerCondition must be present in event.data
    for (const [key, expected] of Object.entries(rule.triggerCondition)) {
      const actual = event.data[key];
      if (actual === undefined) {
        return false;
      }

      // Support simple operators: ">" "< " ">=" "<=" "!="
      if (typeof expected === "string" && expected.startsWith(">")) {
        const threshold = Number(expected.slice(1));
        if (Number(actual) <= threshold) {
          return false;
        }
      } else if (typeof expected === "string" && expected.startsWith("<")) {
        const threshold = Number(expected.slice(1));
        if (Number(actual) >= threshold) {
          return false;
        }
      } else if (typeof expected === "string" && expected.startsWith("!=")) {
        const compare = expected.slice(2);
        if (String(actual) === compare) {
          return false;
        }
      } else if (typeof expected === "string" && expected.startsWith("contains:")) {
        const substring = expected.slice("contains:".length);
        if (!String(actual).includes(substring)) {
          return false;
        }
      } else {
        // Exact match
        if (String(actual) !== String(expected)) {
          return false;
        }
      }
    }

    return true;
  }

  private passesCooldown(rule: ProactiveRule): boolean {
    if (!rule.lastFiredAt) {
      return true;
    }
    return Date.now() - rule.lastFiredAt.getTime() >= rule.cooldownMs;
  }

  private passesGuard(rule: ProactiveRule, event: TriggerEvent): boolean {
    if (!rule.guardExpression) {
      return true;
    }

    // Simple guard expression evaluation: "key == 'value'"
    // This is intentionally limited to avoid eval() — extend as needed
    const match = rule.guardExpression.match(/^(\w+)\s*(==|!=)\s*'([^']*)'$/);
    if (!match) {
      log.warn(`Invalid guard expression: ${rule.guardExpression}`);
      return true; // Fail-open: invalid guard doesn't block
    }

    const [, key, op, value] = match;
    const actual = String(event.data[key] ?? "");

    if (op === "==") {
      return actual === value;
    }
    if (op === "!=") {
      return actual !== value;
    }
    return true;
  }

  private passesMaxFires(rule: ProactiveRule): boolean {
    if (rule.maxFires === 0) {
      return true; // Unlimited
    }
    return rule.fireCount < rule.maxFires;
  }

  private recordFiring(ruleId: string, _triggerData: Record<string, unknown>): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE proactive_rules SET
        last_fired_at = ?, fire_count = fire_count + 1, updated_at = ?
      WHERE id = ?`,
      )
      .run(now, now, ruleId);
  }

  private logAction(
    ruleId: string,
    triggerData: Record<string, unknown>,
    result: unknown,
    success: boolean,
  ): void {
    this.db
      .prepare(
        `INSERT INTO proactive_log (id, rule_id, agent_id, fired_at, trigger_data, action_result, success, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        ruleId,
        this.agentId,
        new Date().toISOString(),
        jsonToSql(triggerData),
        jsonToSql(result),
        booleanToSql(success),
        success ? null : String(result),
      );
  }

  // ============================================================================
  // LOGS
  // ============================================================================

  /** Get action log entries */
  getLogs(limit = 50): ProactiveLogEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM proactive_log WHERE agent_id = ?
       ORDER BY fired_at DESC LIMIT ?`,
      )
      .all(this.agentId, limit) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: row.id as string,
      ruleId: row.rule_id as string,
      agentId: row.agent_id as string,
      firedAt: new Date(row.fired_at as string),
      triggerData: sqlToJson<Record<string, unknown>>(row.trigger_data as string | null),
      actionResult: sqlToJson(row.action_result as string | null),
      success: sqlToBoolean(row.success as number),
      error: (row.error as string) || undefined,
    }));
  }

  // ============================================================================
  // STATISTICS
  // ============================================================================

  getStats(): {
    totalRules: number;
    enabledRules: number;
    totalFirings: number;
    successRate: number;
  } {
    type CountRow = { count: number };

    const total = this.db
      .prepare("SELECT COUNT(*) as count FROM proactive_rules WHERE agent_id = ?")
      .get(this.agentId) as CountRow;

    const enabled = this.db
      .prepare("SELECT COUNT(*) as count FROM proactive_rules WHERE agent_id = ? AND enabled = 1")
      .get(this.agentId) as CountRow;

    const firings = this.db
      .prepare("SELECT COUNT(*) as count FROM proactive_log WHERE agent_id = ?")
      .get(this.agentId) as CountRow;

    const successes = this.db
      .prepare("SELECT COUNT(*) as count FROM proactive_log WHERE agent_id = ? AND success = 1")
      .get(this.agentId) as CountRow;

    return {
      totalRules: total.count,
      enabledRules: enabled.count,
      totalFirings: firings.count,
      successRate: firings.count > 0 ? successes.count / firings.count : 0,
    };
  }

  // ============================================================================
  // PRIVATE HELPERS
  // ============================================================================

  private rowToRule(row: Record<string, unknown>): ProactiveRule {
    return {
      id: row.id as string,
      agentId: row.agent_id as string,
      triggerType: row.trigger_type as TriggerType,
      triggerCondition: JSON.parse(row.trigger_condition as string) as Record<string, unknown>,
      actionType: row.action_type as ActionType,
      actionPayload: JSON.parse(row.action_payload as string) as Record<string, unknown>,
      priority: row.priority as RulePriority,
      enabled: sqlToBoolean(row.enabled as number),
      cooldownMs: row.cooldown_ms as number,
      lastFiredAt: row.last_fired_at ? new Date(row.last_fired_at as string) : undefined,
      fireCount: row.fire_count as number,
      maxFires: row.max_fires as number,
      guardExpression: (row.guard_expression as string) || undefined,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
    };
  }
}

// ============================================================================
// FACTORY
// ============================================================================

const proactiveManagers = new Map<string, ProactiveManager>();

export function getProactiveManager(agentId: string): ProactiveManager {
  if (!proactiveManagers.has(agentId)) {
    proactiveManagers.set(agentId, new ProactiveManager(agentId));
  }
  return proactiveManagers.get(agentId)!;
}
