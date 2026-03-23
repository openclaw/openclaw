import type { HealthSummary } from "../commands/health.js";
import { requestHeartbeatNow } from "../infra/heartbeat-wake.js";
import { getStateDb } from "../infra/state-db/connection.js";
import { cleanOldMedia } from "../media/store.js";
import { reconcileBudgets } from "../orchestration/budget-cron.js";
import { abortChatRunById, type ChatAbortControllerEntry } from "./chat-abort.js";
import type { ChatRunEntry } from "./server-chat.js";
import {
  DEDUPE_MAX,
  DEDUPE_TTL_MS,
  HEALTH_REFRESH_INTERVAL_MS,
  TICK_INTERVAL_MS,
} from "./server-constants.js";
import type { DedupeEntry } from "./server-shared.js";
import { formatError } from "./server-utils.js";
import { setBroadcastHealthUpdate } from "./server/health-state.js";

const DELEGATION_POLL_INTERVAL_MS = 30_000;
const DELEGATION_STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

type ActiveRunRow = {
  run_id: string;
  child_session_key: string;
  requester_session_key: string;
  agent_id: string | null;
  task: string | null;
  label: string | null;
  created_at: number | null;
  started_at: number | null;
  ended_at: number | null;
  outcome: string | null;
  result_preview: string | null;
};

function computeDelegationStatus(
  row: ActiveRunRow,
): "pending" | "running" | "stale" | "done" | "failed" {
  if (row.ended_at != null) {
    // Check if the outcome indicates failure/interruption
    if (row.outcome) {
      try {
        const o = JSON.parse(row.outcome) as Record<string, unknown>;
        const s = o.status;
        if (s === "error" || s === "interrupted" || s === "cancelled" || s === "timeout") {
          return "failed";
        }
      } catch {}
    }
    return "done";
  }
  if (row.started_at != null) {
    const ageMs = Date.now() - row.started_at;
    if (ageMs > DELEGATION_STALE_THRESHOLD_MS) {
      return "stale";
    }
    return "running";
  }
  return "pending";
}

export function startGatewayMaintenanceTimers(params: {
  broadcast: (
    event: string,
    payload: unknown,
    opts?: {
      dropIfSlow?: boolean;
      stateVersion?: { presence?: number; health?: number };
    },
  ) => void;
  nodeSendToAllSubscribed: (event: string, payload: unknown) => void;
  getPresenceVersion: () => number;
  getHealthVersion: () => number;
  refreshGatewayHealthSnapshot: (opts?: { probe?: boolean }) => Promise<HealthSummary>;
  logHealth: { error: (msg: string) => void };
  dedupe: Map<string, DedupeEntry>;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  chatRunState: { abortedRuns: Map<string, number> };
  chatRunBuffers: Map<string, string>;
  chatDeltaSentAt: Map<string, number>;
  removeChatRun: (
    sessionId: string,
    clientRunId: string,
    sessionKey?: string,
  ) => ChatRunEntry | undefined;
  agentRunSeq: Map<string, number>;
  nodeSendToSession: (sessionKey: string, event: string, payload: unknown) => void;
  mediaCleanupTtlMs?: number;
}): {
  tickInterval: ReturnType<typeof setInterval>;
  healthInterval: ReturnType<typeof setInterval>;
  dedupeCleanup: ReturnType<typeof setInterval>;
  delegationCheckInterval: ReturnType<typeof setInterval>;
  mediaCleanup: ReturnType<typeof setInterval> | null;
} {
  setBroadcastHealthUpdate((snap: HealthSummary) => {
    params.broadcast("health", snap, {
      stateVersion: {
        presence: params.getPresenceVersion(),
        health: params.getHealthVersion(),
      },
    });
    params.nodeSendToAllSubscribed("health", snap);
  });

  // periodic keepalive
  const tickInterval = setInterval(() => {
    const payload = { ts: Date.now() };
    params.broadcast("tick", payload, { dropIfSlow: true });
    params.nodeSendToAllSubscribed("tick", payload);
  }, TICK_INTERVAL_MS);

  // periodic health refresh to keep cached snapshot warm
  const healthInterval = setInterval(() => {
    void params
      .refreshGatewayHealthSnapshot({ probe: true })
      .catch((err) => params.logHealth.error(`refresh failed: ${formatError(err)}`));
  }, HEALTH_REFRESH_INTERVAL_MS);

  // Prime cache so first client gets a snapshot without waiting.
  void params
    .refreshGatewayHealthSnapshot({ probe: true })
    .catch((err) => params.logHealth.error(`initial refresh failed: ${formatError(err)}`));

  // dedupe cache cleanup
  const dedupeCleanup = setInterval(() => {
    const AGENT_RUN_SEQ_MAX = 10_000;
    const now = Date.now();
    for (const [k, v] of params.dedupe) {
      if (now - v.ts > DEDUPE_TTL_MS) {
        params.dedupe.delete(k);
      }
    }
    if (params.dedupe.size > DEDUPE_MAX) {
      const entries = [...params.dedupe.entries()].toSorted((a, b) => a[1].ts - b[1].ts);
      for (let i = 0; i < params.dedupe.size - DEDUPE_MAX; i++) {
        params.dedupe.delete(entries[i][0]);
      }
    }

    if (params.agentRunSeq.size > AGENT_RUN_SEQ_MAX) {
      const excess = params.agentRunSeq.size - AGENT_RUN_SEQ_MAX;
      let removed = 0;
      for (const runId of params.agentRunSeq.keys()) {
        params.agentRunSeq.delete(runId);
        removed += 1;
        if (removed >= excess) {
          break;
        }
      }
    }

    for (const [runId, entry] of params.chatAbortControllers) {
      if (now <= entry.expiresAtMs) {
        continue;
      }
      abortChatRunById(
        {
          chatAbortControllers: params.chatAbortControllers,
          chatRunBuffers: params.chatRunBuffers,
          chatDeltaSentAt: params.chatDeltaSentAt,
          chatAbortedRuns: params.chatRunState.abortedRuns,
          removeChatRun: params.removeChatRun,
          agentRunSeq: params.agentRunSeq,
          broadcast: params.broadcast,
          nodeSendToSession: params.nodeSendToSession,
        },
        { runId, sessionKey: entry.sessionKey, stopReason: "timeout" },
      );
    }

    const ABORTED_RUN_TTL_MS = 60 * 60_000;
    for (const [runId, abortedAt] of params.chatRunState.abortedRuns) {
      if (now - abortedAt <= ABORTED_RUN_TTL_MS) {
        continue;
      }
      params.chatRunState.abortedRuns.delete(runId);
      params.chatRunBuffers.delete(runId);
      params.chatDeltaSentAt.delete(runId);
    }
  }, 60_000);

  // Hourly budget policy reconciliation — creates incidents when thresholds are crossed
  const runBudgetReconcile = () => {
    try {
      reconcileBudgets(params.broadcast);
    } catch (err) {
      params.logHealth.error(`budget reconciliation failed: ${formatError(err)}`);
    }
  };
  setInterval(runBudgetReconcile, 60 * 60_000);
  // Prime on startup so incidents are detected without waiting an hour
  runBudgetReconcile();

  // delegation status polling — queries active subagent runs and broadcasts events
  let isFirstDelegationRun = true;
  const runDelegationCheck = () => {
    try {
      const db = getStateDb();
      const rows = db
        .prepare(
          `SELECT run_id, child_session_key, requester_session_key, agent_id,
                  task, label, created_at, started_at, ended_at,
                  outcome_json AS outcome,
                  substr(frozen_result_text, 1, 500) AS result_preview
           FROM op1_subagent_runs
           WHERE cleanup_completed_at IS NULL
           ORDER BY created_at DESC
           LIMIT 50`,
        )
        .all() as ActiveRunRow[];

      // On the first run after gateway startup, fire a heartbeat so the agent can notice
      // any stale delegations and re-spawn work as needed.
      if (isFirstDelegationRun) {
        isFirstDelegationRun = false;
        // Fire a heartbeat so the agent can re-evaluate pending/stale delegations after restart
        try {
          requestHeartbeatNow({ reason: "delegation-resume" });
        } catch {
          // Non-fatal: heartbeat handler may not be registered yet (e.g. during tests)
        }
      }

      // Detect zombie runs on EVERY check: started but never ended, running longer than
      // DELEGATION_STALE_THRESHOLD_MS. These are processes killed by a gateway restart (or
      // any other crash) whose records were never closed out.
      const nowMs = Date.now();
      for (const row of rows) {
        if (
          row.started_at != null &&
          row.ended_at == null &&
          nowMs - row.started_at > DELEGATION_STALE_THRESHOLD_MS
        ) {
          params.logHealth.error(
            `delegation: zombie run ${row.run_id} (agent=${row.agent_id ?? "?"}, ` +
              `task=${(row.task ?? "").slice(0, 80)}) — started_at set but no ended_at after ` +
              `${Math.round((nowMs - row.started_at) / 1000)}s, marking interrupted`,
          );
          try {
            db.prepare(
              `UPDATE op1_subagent_runs
               SET ended_at = ?, outcome_json = ?, ended_reason = ?, cleanup_completed_at = ?
               WHERE run_id = ?`,
            ).run(
              nowMs,
              JSON.stringify({ status: "interrupted", reason: "zombie_process" }),
              "zombie_process",
              nowMs,
              row.run_id,
            );
          } catch (updateErr) {
            params.logHealth.error(
              `delegation: failed to mark zombie run ${row.run_id} as ended: ${formatError(updateErr)}`,
            );
          }
        }
      }

      // Broadcast ALL delegations (including recently completed/failed) so UI can update status
      const nowBroadcast = Date.now();
      const allDelegations = rows.map((r) => ({
        runId: r.run_id,
        childSessionKey: r.child_session_key,
        sessionKey: r.requester_session_key,
        agentId: r.agent_id,
        task: r.task,
        label: r.label,
        status: computeDelegationStatus(r),
        createdAt: r.created_at ?? 0,
        startedAt: r.started_at ?? null,
        endedAt: r.ended_at ?? null,
        resultPreview: r.result_preview ?? null,
        elapsedMs: r.created_at != null ? nowBroadcast - r.created_at : 0,
      }));

      if (allDelegations.length > 0) {
        params.broadcast("delegation", { delegations: allDelegations });
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("no such table")) {
        return; // schema not migrated yet — skip silently
      }
      params.logHealth.error(`delegation check failed: ${formatError(err)}`);
    }
  };

  // Prime immediately so UI gets state on first connect without waiting 30s
  runDelegationCheck();
  const delegationCheckInterval = setInterval(runDelegationCheck, DELEGATION_POLL_INTERVAL_MS);

  if (typeof params.mediaCleanupTtlMs !== "number") {
    return {
      tickInterval,
      healthInterval,
      dedupeCleanup,
      delegationCheckInterval,
      mediaCleanup: null,
    };
  }

  let mediaCleanupInFlight: Promise<void> | null = null;
  const runMediaCleanup = () => {
    if (mediaCleanupInFlight) {
      return mediaCleanupInFlight;
    }
    mediaCleanupInFlight = cleanOldMedia(params.mediaCleanupTtlMs, {
      recursive: true,
      pruneEmptyDirs: true,
    })
      .catch((err) => {
        params.logHealth.error(`media cleanup failed: ${formatError(err)}`);
      })
      .finally(() => {
        mediaCleanupInFlight = null;
      });
    return mediaCleanupInFlight;
  };

  const mediaCleanup = setInterval(() => {
    void runMediaCleanup();
  }, 60 * 60_000);

  void runMediaCleanup();

  return { tickInterval, healthInterval, dedupeCleanup, delegationCheckInterval, mediaCleanup };
}
