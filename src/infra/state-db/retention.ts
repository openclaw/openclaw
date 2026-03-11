/**
 * Retention / cleanup for operator1.db tables.
 *
 * Runs on gateway startup and daily schedule.
 * Each job is independent — one failure doesn't block others.
 * Uses per-entity loops for capped tables to avoid O(n²) correlated subqueries.
 */
import type { DatabaseSync } from "node:sqlite";

interface RetentionResult {
  job: string;
  deleted: number;
  error?: string;
}

/** Run all retention cleanup jobs. Returns results per job. */
export function runRetention(db: DatabaseSync): RetentionResult[] {
  const results: RetentionResult[] = [];

  results.push(retainTeamMessages(db));
  results.push(retainDeliveryQueue(db));
  results.push(retainCronRuns(db));
  results.push(retainSubagentRuns(db));
  results.push(retainAuditState(db));
  results.push(retainAuditConfig(db));

  return results;
}

// ── Active P0 retention jobs ────────────────────────────────────────────────

/** Keep last 2000 messages per team. */
function retainTeamMessages(db: DatabaseSync): RetentionResult {
  return safeRetain("op1_team_messages", db, () => {
    let total = 0;
    const teams = db.prepare("SELECT DISTINCT team_id FROM op1_team_messages").all() as Array<{
      team_id: string;
    }>;

    for (const { team_id } of teams) {
      const info = db
        .prepare(
          `DELETE FROM op1_team_messages WHERE team_id = ? AND id NOT IN (
            SELECT id FROM op1_team_messages WHERE team_id = ? ORDER BY created_at DESC LIMIT 2000
          )`,
        )
        .run(team_id, team_id);
      total += info.changes;
    }
    return total;
  });
}

/** Purge delivered/failed queue items older than 7 days. */
function retainDeliveryQueue(db: DatabaseSync): RetentionResult {
  return safeRetain("delivery_queue", db, () => {
    const info = db
      .prepare(
        `DELETE FROM delivery_queue
         WHERE status IN ('delivered', 'failed')
         AND created_at < unixepoch() - (7 * 86400)`,
      )
      .run();
    return info.changes;
  });
}

// ── Stub retention jobs (active once their tables exist in later phases) ────

/** Cap cron_runs at 500 per job. Stub until Phase 4 creates the table. */
function retainCronRuns(db: DatabaseSync): RetentionResult {
  return safeRetain("cron_runs", db, () => {
    if (!tableExists(db, "cron_runs")) {
      return 0;
    }
    let total = 0;
    const jobs = db.prepare("SELECT DISTINCT job_id FROM cron_runs").all() as Array<{
      job_id: string;
    }>;

    for (const { job_id } of jobs) {
      const info = db
        .prepare(
          `DELETE FROM cron_runs WHERE job_id = ? AND id NOT IN (
            SELECT id FROM cron_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT 500
          )`,
        )
        .run(job_id, job_id);
      total += info.changes;
    }
    return total;
  });
}

/** Delete finished subagent runs older than 30 days. Stub until Phase 3. */
function retainSubagentRuns(db: DatabaseSync): RetentionResult {
  return safeRetain("agent_subagent_runs", db, () => {
    if (!tableExists(db, "agent_subagent_runs")) {
      return 0;
    }
    const info = db
      .prepare(
        `DELETE FROM agent_subagent_runs
         WHERE status IN ('completed', 'failed', 'cancelled')
         AND finished_at < unixepoch() - (30 * 86400)`,
      )
      .run();
    return info.changes;
  });
}

/** Keep last 90 days of audit_state. Stub until Phase 3. */
function retainAuditState(db: DatabaseSync): RetentionResult {
  return safeRetain("audit_state", db, () => {
    if (!tableExists(db, "audit_state")) {
      return 0;
    }
    const info = db
      .prepare("DELETE FROM audit_state WHERE created_at < unixepoch() - (90 * 86400)")
      .run();
    return info.changes;
  });
}

/** Keep last 90 days of audit_config. Stub until Phase 6. */
function retainAuditConfig(db: DatabaseSync): RetentionResult {
  return safeRetain("audit_config", db, () => {
    if (!tableExists(db, "audit_config")) {
      return 0;
    }
    const info = db
      .prepare("DELETE FROM audit_config WHERE created_at < unixepoch() - (90 * 86400)")
      .run();
    return info.changes;
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  return row != null;
}

function safeRetain(job: string, db: DatabaseSync, fn: () => number): RetentionResult {
  try {
    const deleted = fn();
    return { job, deleted };
  } catch (err) {
    return {
      job,
      deleted: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
