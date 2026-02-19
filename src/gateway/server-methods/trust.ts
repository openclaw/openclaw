import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_AGENT_WORKSPACE_DIR } from "../../agents/workspace.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

/**
 * Trust RPCs — expose trust scores and demotion history to the dashboard.
 */

type TrustProfile = {
  agentId: string;
  trustScore: number;
  level: string;
  role: string;
  components: Record<string, number>;
  promotionReadiness: number;
  tasksCompleted: number;
  incidentCount: number;
  lastUpdated: string;
  costMetrics?: { dailyAvg: number; budget: number };
};

type TrustEvent = {
  timestamp: string;
  agent: string;
  trigger: string;
  severity: string;
  action: string;
  message: string;
  type: string;
};

async function loadTrustProfile(agentId: string): Promise<TrustProfile | null> {
  const perfPath = path.join(DEFAULT_AGENT_WORKSPACE_DIR, "agents", agentId, "performance.json");
  try {
    const raw = await fs.readFile(perfPath, "utf-8");
    const data = JSON.parse(raw);
    return {
      agentId,
      trustScore: data.trustScore ?? 0,
      level: data.level ?? "L1",
      role: data.role ?? "IC",
      components: data.components ?? {},
      promotionReadiness: data.promotionReadiness ?? 0,
      tasksCompleted: data.tasksCompleted ?? 0,
      incidentCount: data.incidentCount ?? 0,
      lastUpdated: data.lastUpdated ?? "",
      costMetrics: data.costMetrics,
    };
  } catch {
    return null;
  }
}

async function loadTrustLog(): Promise<TrustEvent[]> {
  const logPath = path.join(DEFAULT_AGENT_WORKSPACE_DIR, "memory", "trust-log.json");
  try {
    const raw = await fs.readFile(logPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

export const trustHandlers: GatewayRequestHandlers = {
  "trust.profile": async ({ params, respond }) => {
    const agentId = (params as { agentId?: string }).agentId ?? "jeeves";
    try {
      const profile = await loadTrustProfile(agentId);
      if (!profile) {
        respond(false, undefined, errorShape(ErrorCodes.NOT_FOUND, `Agent ${agentId} not found`));
        return;
      }
      respond(true, profile, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },

  "trust.log": async ({ params, respond }) => {
    const agentId = (params as { agentId?: string }).agentId;
    try {
      let log = await loadTrustLog();
      if (agentId) {
        log = log.filter((e) => e.agent === agentId);
      }
      // Return last 50 events
      respond(true, { events: log.slice(-50), fetchedAt: Date.now() }, undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
};
