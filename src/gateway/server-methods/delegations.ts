import { requestHeartbeatNow } from "../../infra/heartbeat-wake.js";
import { getStateDb } from "../../infra/state-db/connection.js";
import { listActiveDelegations } from "../../orchestration/delegation-tracker-sqlite.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

export const delegationsHandlers: GatewayRequestHandlers = {
  "sessions.delegations": async ({ params, respond }) => {
    const p = params as {
      sessionKey?: unknown;
      includeCompleted?: unknown;
      limit?: unknown;
    };

    const sessionKey = typeof p.sessionKey === "string" ? p.sessionKey.trim() : "";
    if (!sessionKey) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "sessionKey required"));
      return;
    }

    const includeCompleted = typeof p.includeCompleted === "boolean" ? p.includeCompleted : false;
    const limit = typeof p.limit === "number" && p.limit > 0 ? Math.min(p.limit, 100) : undefined;

    try {
      const delegations = listActiveDelegations(sessionKey, {
        includeCompleted,
        limit,
      });
      respond(true, { delegations });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, msg));
    }
  },

  "sessions.delegations.resume": async ({ params, respond }) => {
    const p = params as { runId?: unknown };
    const runId = typeof p.runId === "string" ? p.runId.trim() : "";
    if (!runId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "runId required"));
      return;
    }

    try {
      const db = getStateDb();
      const row = db.prepare("SELECT * FROM op1_subagent_runs WHERE run_id = ?").get(runId) as
        | { run_id: string }
        | undefined;
      if (!row) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `Run not found: ${runId}`),
        );
        return;
      }

      // Read the original task and requester session key
      const fullRow = db
        .prepare(
          "SELECT task, requester_session_key, agent_id, child_session_key, label FROM op1_subagent_runs WHERE run_id = ?",
        )
        .get(runId) as {
        task: string | null;
        requester_session_key: string;
        agent_id: string | null;
        child_session_key: string;
        label: string | null;
      };

      const agentName =
        fullRow.agent_id ?? fullRow.child_session_key?.split(":")?.[1] ?? "the sub-agent";
      const taskText = fullRow.task ?? "the previous task";

      // Mark old run as ended with interrupted status
      const now = Date.now();
      db.prepare(
        "UPDATE op1_subagent_runs SET ended_at = ?, outcome_json = ?, ended_reason = ?, cleanup_completed_at = ? WHERE run_id = ?",
      ).run(
        now,
        JSON.stringify({ status: "interrupted", reason: "manual_resume" }),
        "manual_resume",
        now,
        runId,
      );

      // Inject a system message into the requester's session to trigger re-delegation
      const { enqueueSystemEvent } = await import("../../infra/system-events.js");
      enqueueSystemEvent(
        `[Delegation Resume] The previous delegation to ${agentName} was interrupted. Please re-delegate the following task:\n\n${taskText}`,
        { sessionKey: fullRow.requester_session_key },
      );

      // Also fire heartbeat as backup
      requestHeartbeatNow({ reason: "delegation-resume" });

      respond(true, { ok: true, previousRunId: runId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, msg));
    }
  },

  "sessions.delegations.cancel": async ({ params, respond }) => {
    const p = params as { runId?: unknown };
    const runId = typeof p.runId === "string" ? p.runId.trim() : "";
    if (!runId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "runId required"));
      return;
    }

    try {
      const db = getStateDb();
      const row = db.prepare("SELECT * FROM op1_subagent_runs WHERE run_id = ?").get(runId) as
        | { run_id: string }
        | undefined;
      if (!row) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `Run not found: ${runId}`),
        );
        return;
      }

      const now = Date.now();
      db.prepare(
        "UPDATE op1_subagent_runs SET ended_at = ?, outcome_json = ?, ended_reason = ?, cleanup_completed_at = ? WHERE run_id = ?",
      ).run(now, JSON.stringify({ status: "cancelled" }), "manual_cancel", now, runId);

      respond(true, { ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, msg));
    }
  },

  "sessions.delegations.retry": async ({ params, respond }) => {
    const p = params as { runId?: unknown };
    const runId = typeof p.runId === "string" ? p.runId.trim() : "";
    if (!runId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "runId required"));
      return;
    }

    try {
      const db = getStateDb();
      const fullRow = db
        .prepare(
          "SELECT run_id, task, requester_session_key, agent_id, child_session_key, label FROM op1_subagent_runs WHERE run_id = ?",
        )
        .get(runId) as
        | {
            run_id: string;
            task: string | null;
            requester_session_key: string;
            agent_id: string | null;
            child_session_key: string;
            label: string | null;
          }
        | undefined;
      if (!fullRow) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `Run not found: ${runId}`),
        );
        return;
      }

      const agentName =
        fullRow.agent_id ?? fullRow.child_session_key?.split(":")?.[1] ?? "the sub-agent";
      const taskText = fullRow.task ?? "the previous task";

      // Mark old run as ended
      const now = Date.now();
      db.prepare(
        "UPDATE op1_subagent_runs SET ended_at = ?, outcome_json = ?, ended_reason = ?, cleanup_completed_at = ? WHERE run_id = ?",
      ).run(
        now,
        JSON.stringify({ status: "interrupted", reason: "manual_retry" }),
        "manual_retry",
        now,
        runId,
      );

      // Inject a retry message into the requester's session to trigger re-delegation
      const { enqueueSystemEvent } = await import("../../infra/system-events.js");
      enqueueSystemEvent(
        `[Delegation Retry] Please re-delegate this task to ${agentName}:\n\n${taskText}`,
        { sessionKey: fullRow.requester_session_key },
      );

      respond(true, { ok: true, previousRunId: runId });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, msg));
    }
  },

  "sessions.delegations.markComplete": async ({ params, respond }) => {
    const p = params as { runId?: unknown };
    const runId = typeof p.runId === "string" ? p.runId.trim() : "";
    if (!runId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "runId required"));
      return;
    }

    try {
      const db = getStateDb();
      const row = db.prepare("SELECT * FROM op1_subagent_runs WHERE run_id = ?").get(runId) as
        | { run_id: string }
        | undefined;
      if (!row) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `Run not found: ${runId}`),
        );
        return;
      }

      const now = Date.now();
      db.prepare(
        "UPDATE op1_subagent_runs SET ended_at = ?, outcome_json = ?, cleanup_completed_at = ? WHERE run_id = ?",
      ).run(now, JSON.stringify({ status: "ok", reason: "manual_complete" }), now, runId);

      respond(true, { ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, msg));
    }
  },
};
