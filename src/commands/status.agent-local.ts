// Reads local agent/session state for status output.
// This never contacts the gateway; it inspects configured agents and their read-only session stores.

import path from "node:path";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { measureCliCommandStartup } from "../cli/command-startup-timing.js";
import type { OpenClawConfig } from "../config/types.js";
import { listGatewayAgentsBasic, type GatewayAgentOwnership } from "../gateway/agent-list.js";
import { pathExists } from "../infra/fs-safe.js";
import {
  evaluateAgentDatabaseAdmissions,
  hasAgentDatabaseAdmissions,
  recordAgentDatabaseAdmissions,
  type AgentDatabaseAdmissionRefusal,
} from "../state/agent-database-admission.js";
import { readStatusSessionStores, STATUS_RECENT_SESSION_LIMIT } from "../status/session-stores.js";

export type AgentLocalStatus = {
  id: string;
  status?: "degraded";
  admissionRefusal?: AgentDatabaseAdmissionRefusal;
  name?: string;
  workspaceDir: string | null;
  bootstrapPending: boolean | null;
  sessionsPath: string;
  sessionsCount: number;
  lastUpdatedAt: number | null;
  lastActiveAgeMs: number | null;
};

export type AgentLocalStatusesResult = {
  defaultId: string | null;
  ownership: GatewayAgentOwnership;
  selectionRequired: boolean;
  agents: AgentLocalStatus[];
  totalSessions: number;
  bootstrapPendingCount: number;
};

/** Returns per-agent local workspace, bootstrap, session count, and last activity status. */
export async function collectStatusLocalSnapshot(cfg: OpenClawConfig) {
  if (!hasAgentDatabaseAdmissions()) {
    recordAgentDatabaseAdmissions(
      await measureCliCommandStartup(
        "status.agent-admission",
        () => evaluateAgentDatabaseAdmissions(cfg),
        { config: cfg },
      ),
    );
  }
  const agentList = listGatewayAgentsBasic(cfg);
  const now = Date.now();

  const sessionStores = await measureCliCommandStartup(
    "status.session-stores",
    () => readStatusSessionStores(cfg, agentList.agents, STATUS_RECENT_SESSION_LIMIT),
    { config: cfg },
  );
  const statuses: AgentLocalStatus[] = [];
  for (const { agent, path: sessionsPath, count, recent } of sessionStores.byAgent) {
    const agentId = agent.id;
    const workspaceDir = (() => {
      try {
        return resolveAgentWorkspaceDir(cfg, agentId);
      } catch {
        // A malformed workspace setting should not prevent status from showing other agents.
        return null;
      }
    })();

    const bootstrapPath = workspaceDir != null ? path.join(workspaceDir, "BOOTSTRAP.md") : null;
    const bootstrapPending = bootstrapPath != null ? await pathExists(bootstrapPath) : null;

    const lastUpdatedAt = recent[0]?.entry.updatedAt ?? 0;
    const resolvedLastUpdatedAt = lastUpdatedAt > 0 ? lastUpdatedAt : null;
    const lastActiveAgeMs = resolvedLastUpdatedAt ? now - resolvedLastUpdatedAt : null;

    statuses.push({
      id: agentId,
      ...(agent.admissionRefusal
        ? { status: agent.status, admissionRefusal: agent.admissionRefusal }
        : {}),
      name: agent.name,
      workspaceDir,
      bootstrapPending,
      sessionsPath,
      sessionsCount: count,
      lastUpdatedAt: resolvedLastUpdatedAt,
      lastActiveAgeMs,
    });
  }

  const bootstrapPendingCount = statuses.reduce((sum, s) => sum + (s.bootstrapPending ? 1 : 0), 0);
  const agentStatus: AgentLocalStatusesResult = {
    // The gateway keeps a projected first id for wire compatibility. Local status must
    // preserve the selection state so read-only consumers never treat that id as an owner.
    defaultId: agentList.selectionRequired ? null : agentList.defaultId,
    ownership: agentList.ownership,
    selectionRequired: agentList.selectionRequired,
    agents: statuses,
    totalSessions: sessionStores.count,
    bootstrapPendingCount,
  };
  return { agentStatus, sessionStores };
}
