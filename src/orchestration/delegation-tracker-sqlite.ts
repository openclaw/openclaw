import { getStateDb } from "../infra/state-db/connection.js";

export interface DelegationSummary {
  runId: string;
  childSessionKey: string;
  agentId: string | null;
  task: string | null;
  label: string | null;
  status: "spawned" | "running" | "completed" | "failed" | "stale";
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  outcome: string | null; // JSON
  resultPreview: string | null; // first 500 chars of frozen_result_text
  elapsedMs: number;
}

/** Raw row shape returned from the DB query. */
interface SubagentRunRow {
  run_id: string;
  child_session_key: string;
  agent_id: string | null;
  task: string | null;
  label: string | null;
  created_at: number | null;
  started_at: number | null;
  ended_at: number | null;
  outcome_json: string | null;
  frozen_result_text: string | null;
  cleanup_completed_at: number | null;
}

function deriveStatus(row: SubagentRunRow, nowMs: number): DelegationSummary["status"] {
  if (!row.started_at) {
    return "spawned";
  }
  if (!row.ended_at) {
    // Running for more than 10 minutes counts as stale
    const elapsedMs = nowMs - row.started_at;
    return elapsedMs > 600_000 ? "stale" : "running";
  }
  // Determine success vs failure from outcome_json
  if (row.outcome_json) {
    try {
      const outcome = JSON.parse(row.outcome_json) as Record<string, unknown>;
      const s = outcome.status;
      if (
        outcome.error ||
        outcome.failed ||
        s === "error" ||
        s === "interrupted" ||
        s === "cancelled" ||
        s === "timeout"
      ) {
        return "failed";
      }
    } catch {
      // If JSON is unparseable, treat as completed
    }
  }
  return "completed";
}

export function listActiveDelegations(
  sessionKey: string,
  opts?: {
    includeCompleted?: boolean;
    limit?: number;
  },
): DelegationSummary[] {
  const db = getStateDb();
  const includeCompleted = opts?.includeCompleted ?? false;
  const limit = opts?.limit ?? 20;

  const whereClauses = ["requester_session_key = ?"];
  const bindings: (string | number)[] = [sessionKey];

  // When not including completed, only return rows where cleanup has not run
  if (!includeCompleted) {
    whereClauses.push("cleanup_completed_at IS NULL");
  }

  const sql = `
    SELECT
      run_id,
      child_session_key,
      agent_id,
      task,
      label,
      created_at,
      started_at,
      ended_at,
      outcome_json,
      frozen_result_text,
      cleanup_completed_at
    FROM op1_subagent_runs
    WHERE ${whereClauses.join(" AND ")}
    ORDER BY created_at DESC
    LIMIT ?
  `;
  bindings.push(limit);

  const rows = db.prepare(sql).all(...bindings) as unknown as SubagentRunRow[];
  const nowMs = Date.now();

  return rows.map((row): DelegationSummary => {
    const createdAt = row.created_at ?? 0;
    const endedAt = row.ended_at ?? null;
    const refMs = endedAt ?? nowMs;
    const elapsedMs = refMs - createdAt;

    return {
      runId: row.run_id,
      childSessionKey: row.child_session_key,
      agentId: row.agent_id ?? null,
      task: row.task ?? null,
      label: row.label ?? null,
      status: deriveStatus(row, nowMs),
      createdAt,
      startedAt: row.started_at ?? null,
      endedAt,
      outcome: row.outcome_json ?? null,
      resultPreview: row.frozen_result_text ? row.frozen_result_text.slice(0, 500) : null,
      elapsedMs: Math.max(0, elapsedMs),
    };
  });
}
