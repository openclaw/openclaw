/**
 * agents.health — Aggregate per-agent health overview.
 *
 * Composes data already available via agents.list, sessions.list,
 * sessions.usage, and cron.list into a single summary suitable for
 * dashboard rendering or CLI output.
 */

import type { GatewayRequestHandlers } from "./types.js";
import { listAgentIds } from "../../agents/agent-scope.js";
import { loadConfig } from "../../config/config.js";
import { loadSessionStore, type SessionEntry } from "../../config/sessions.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { listAgentsForGateway } from "../session-utils.js";

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */

export type AgentCronSummary = {
  total: number;
  enabled: number;
  failing: number;
  nextRunAtMs: number | null;
  lastFailure: {
    jobId: string;
    jobName: string;
    lastRunAtMs: number;
    lastDurationMs: number;
  } | null;
};

export type AgentSessionSummary = {
  key: string;
  model: string | undefined;
  totalTokens: number;
  updatedAtMs: number;
};

export type AgentHealthEntry = {
  agentId: string;
  displayName: string | undefined;
  status: "healthy" | "warning" | "error" | "unknown";
  statusReason: string | undefined;
  mainSession: AgentSessionSummary | null;
  activeSessions: number;
  cron: AgentCronSummary;
};

export type AgentsHealthResult = {
  agents: AgentHealthEntry[];
  generatedAtMs: number;
};

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

function deriveStatus(
  mainSession: AgentSessionSummary | null,
  cronSummary: AgentCronSummary,
): { status: AgentHealthEntry["status"]; reason: string | undefined } {
  if (cronSummary.failing > 0) {
    return {
      status: "warning",
      reason: `${cronSummary.failing} cron job(s) failing`,
    };
  }

  if (mainSession) {
    const age = Date.now() - mainSession.updatedAtMs;
    if (age > STALE_THRESHOLD_MS) {
      return {
        status: "warning",
        reason: `main session idle for ${Math.round(age / 60_000)}m`,
      };
    }
  }

  if (!mainSession && cronSummary.total === 0) {
    return { status: "unknown", reason: "no sessions or cron jobs" };
  }

  return { status: "healthy", reason: undefined };
}

/* ------------------------------------------------------------------ */
/* Handler                                                            */
/* ------------------------------------------------------------------ */

export const agentsHealthHandlers: GatewayRequestHandlers = {
  "agents.health": async ({ respond, context }) => {
    try {
      const cfg = loadConfig();
      const agentIds = listAgentIds(cfg);
      const agentsMeta = listAgentsForGateway(cfg);

      // Load all sessions
      const sessionStore = loadSessionStore();
      const sessionsByAgent = new Map<string, SessionEntry[]>();
      for (const [key, entry] of Object.entries(sessionStore)) {
        const parsed = parseAgentSessionKey(key);
        const aid = parsed?.agentId ?? "main";
        if (!sessionsByAgent.has(aid)) sessionsByAgent.set(aid, []);
        sessionsByAgent.get(aid)!.push(entry as SessionEntry);
      }

      // Load cron jobs
      const cronResult = await context.cron.list({ includeDisabled: true });
      const cronJobs = (cronResult as { jobs?: unknown[] })?.jobs ?? [];
      const cronByAgent = new Map<string, typeof cronJobs>();
      for (const job of cronJobs) {
        const aid = ((job as Record<string, unknown>).agentId as string) ?? "main";
        if (!cronByAgent.has(aid)) cronByAgent.set(aid, []);
        cronByAgent.get(aid)!.push(job);
      }

      // Build per-agent health
      const agents: AgentHealthEntry[] = [];

      for (const agentId of agentIds) {
        const meta = agentsMeta.agents?.find((a: Record<string, unknown>) => a.agentId === agentId);

        // Main session
        const sessions = sessionsByAgent.get(agentId) ?? [];
        const mainSessionEntry = sessions.find(
          (s) => (s as Record<string, unknown>).key === `agent:${agentId}:main`,
        ) as Record<string, unknown> | undefined;

        const mainSession: AgentSessionSummary | null = mainSessionEntry
          ? {
              key: `agent:${agentId}:main`,
              model: mainSessionEntry.model as string | undefined,
              totalTokens: (mainSessionEntry.totalTokens as number) ?? 0,
              updatedAtMs: (mainSessionEntry.updatedAt as number) ?? 0,
            }
          : null;

        // Cron summary
        const agentCrons = cronByAgent.get(agentId) ?? [];
        const enabledCrons = agentCrons.filter(
          (j) => (j as Record<string, unknown>).enabled !== false,
        );
        const failingCrons = enabledCrons.filter((j) => {
          const state = (j as Record<string, unknown>).state as Record<string, unknown> | undefined;
          return state?.lastStatus === "error";
        });

        let nextRunAtMs: number | null = null;
        let lastFailure: AgentCronSummary["lastFailure"] = null;

        for (const j of enabledCrons) {
          const state = (j as Record<string, unknown>).state as Record<string, unknown> | undefined;
          const next = state?.nextRunAtMs as number | undefined;
          if (next && (nextRunAtMs === null || next < nextRunAtMs)) {
            nextRunAtMs = next;
          }
        }

        if (failingCrons.length > 0) {
          const j = failingCrons[0] as Record<string, unknown>;
          const state = j.state as Record<string, unknown>;
          lastFailure = {
            jobId: j.id as string,
            jobName: j.name as string,
            lastRunAtMs: (state?.lastRunAtMs as number) ?? 0,
            lastDurationMs: (state?.lastDurationMs as number) ?? 0,
          };
        }

        const cronSummary: AgentCronSummary = {
          total: agentCrons.length,
          enabled: enabledCrons.length,
          failing: failingCrons.length,
          nextRunAtMs,
          lastFailure,
        };

        const { status, reason } = deriveStatus(mainSession, cronSummary);

        agents.push({
          agentId,
          displayName: (meta as Record<string, unknown>)?.name as string | undefined,
          status,
          statusReason: reason,
          mainSession,
          activeSessions: sessions.length,
          cron: cronSummary,
        });
      }

      const result: AgentsHealthResult = {
        agents,
        generatedAtMs: Date.now(),
      };

      respond(true, result, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INTERNAL_ERROR,
          `agents.health failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  },
};
