/**
 * Agent performance metrics — aggregated from cost events and tasks.
 *
 * This is a read-only query module; it does not own any tables.
 */
import { getStateDb } from "../infra/state-db/connection.js";

export interface AgentMetrics {
  agentId: string;
  workspaceId: string;
  /** Total LLM cost in microcents (sum of op1_cost_events). */
  totalCostMicrocents: number;
  /** Total input tokens consumed. */
  totalInputTokens: number;
  /** Total output tokens produced. */
  totalOutputTokens: number;
  /** Number of tasks with status = 'done' assigned to this agent. */
  tasksCompleted: number;
  /** Number of tasks currently in progress (status = 'in_progress'). */
  tasksInProgress: number;
}

type CostRow = {
  total_cost_microcents: number | null;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
};

type TaskCountRow = {
  status: string;
  cnt: number;
};

/**
 * Compute performance metrics for a single agent within a workspace.
 * All queries are synchronous (node:sqlite DatabaseSync).
 */
export function getAgentMetrics(workspaceId: string, agentId: string): AgentMetrics {
  const db = getStateDb();

  const costRow = db
    .prepare(
      `SELECT
         SUM(cost_microcents) AS total_cost_microcents,
         SUM(input_tokens)    AS total_input_tokens,
         SUM(output_tokens)   AS total_output_tokens
       FROM op1_cost_events
       WHERE workspace_id = ? AND agent_id = ?`,
    )
    .get(workspaceId, agentId) as CostRow | undefined;

  const taskCountRows = db
    .prepare(
      `SELECT status, COUNT(*) AS cnt
       FROM op1_tasks
       WHERE workspace_id = ? AND assignee_agent_id = ?
         AND status IN ('done', 'in_progress')
       GROUP BY status`,
    )
    .all(workspaceId, agentId) as TaskCountRow[];

  let tasksCompleted = 0;
  let tasksInProgress = 0;
  for (const row of taskCountRows) {
    if (row.status === "done") {
      tasksCompleted = Number(row.cnt);
    }
    if (row.status === "in_progress") {
      tasksInProgress = Number(row.cnt);
    }
  }

  return {
    agentId,
    workspaceId,
    totalCostMicrocents: Number(costRow?.total_cost_microcents ?? 0),
    totalInputTokens: Number(costRow?.total_input_tokens ?? 0),
    totalOutputTokens: Number(costRow?.total_output_tokens ?? 0),
    tasksCompleted,
    tasksInProgress,
  };
}

/**
 * Compute metrics for all agents assigned to a workspace in a single pass.
 * Returns one entry per agent found in either cost events or task assignments.
 */
export function listAgentMetricsForWorkspace(workspaceId: string): AgentMetrics[] {
  const db = getStateDb();

  // Aggregate cost events per agent
  const costRows = db
    .prepare(
      `SELECT
         agent_id,
         SUM(cost_microcents) AS total_cost_microcents,
         SUM(input_tokens)    AS total_input_tokens,
         SUM(output_tokens)   AS total_output_tokens
       FROM op1_cost_events
       WHERE workspace_id = ?
       GROUP BY agent_id`,
    )
    .all(workspaceId) as Array<{ agent_id: string } & CostRow>;

  // Aggregate task counts per agent
  const taskRows = db
    .prepare(
      `SELECT assignee_agent_id AS agent_id, status, COUNT(*) AS cnt
       FROM op1_tasks
       WHERE workspace_id = ?
         AND assignee_agent_id IS NOT NULL
         AND status IN ('done', 'in_progress')
       GROUP BY assignee_agent_id, status`,
    )
    .all(workspaceId) as Array<{ agent_id: string; status: string; cnt: number }>;

  // Merge by agentId
  const byAgent = new Map<string, AgentMetrics>();

  const ensureAgent = (agentId: string): AgentMetrics => {
    let m = byAgent.get(agentId);
    if (!m) {
      m = {
        agentId,
        workspaceId,
        totalCostMicrocents: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        tasksCompleted: 0,
        tasksInProgress: 0,
      };
      byAgent.set(agentId, m);
    }
    return m;
  };

  for (const row of costRows) {
    const m = ensureAgent(row.agent_id);
    m.totalCostMicrocents = Number(row.total_cost_microcents ?? 0);
    m.totalInputTokens = Number(row.total_input_tokens ?? 0);
    m.totalOutputTokens = Number(row.total_output_tokens ?? 0);
  }

  for (const row of taskRows) {
    const m = ensureAgent(row.agent_id);
    if (row.status === "done") {
      m.tasksCompleted = Number(row.cnt);
    }
    if (row.status === "in_progress") {
      m.tasksInProgress = Number(row.cnt);
    }
  }

  return [...byAgent.values()];
}

// ── Department Budget Aggregation (6.4) ──────────────────────────────────────

export interface DepartmentBudgetSummary {
  /** Department name as recorded in session_entries.department. */
  department: string;
  /** Total cost in microcents for this department within the workspace. */
  totalCostMicrocents: number;
  /** Total input tokens. */
  totalInputTokens: number;
  /** Total output tokens. */
  totalOutputTokens: number;
  /** Number of distinct agents that logged cost in this department. */
  agentCount: number;
}

/**
 * Aggregate cost events by department for a workspace.
 *
 * The department is resolved via:
 *   op1_cost_events.session_id → session_entries.session_id → session_entries.department
 *
 * Sessions without a department value are grouped under "unknown".
 */
export function listDepartmentBudgetSummary(workspaceId: string): DepartmentBudgetSummary[] {
  const db = getStateDb();

  const rows = db
    .prepare(
      `SELECT
         COALESCE(se.department, 'unknown') AS department,
         SUM(ce.cost_microcents)            AS total_cost_microcents,
         SUM(ce.input_tokens)               AS total_input_tokens,
         SUM(ce.output_tokens)              AS total_output_tokens,
         COUNT(DISTINCT ce.agent_id)        AS agent_count
       FROM op1_cost_events ce
       LEFT JOIN session_entries se
         ON se.session_id = ce.session_id
       WHERE ce.workspace_id = ?
       GROUP BY COALESCE(se.department, 'unknown')
       ORDER BY total_cost_microcents DESC`,
    )
    .all(workspaceId) as Array<{
    department: string;
    total_cost_microcents: number | null;
    total_input_tokens: number | null;
    total_output_tokens: number | null;
    agent_count: number;
  }>;

  return rows.map((r) => ({
    department: r.department,
    totalCostMicrocents: Number(r.total_cost_microcents ?? 0),
    totalInputTokens: Number(r.total_input_tokens ?? 0),
    totalOutputTokens: Number(r.total_output_tokens ?? 0),
    agentCount: Number(r.agent_count),
  }));
}
