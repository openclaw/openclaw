import path from "node:path";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { listSessionEntries } from "../config/sessions/store.js";
import type { OpenClawConfig } from "../config/types.js";
import { listGatewayAgentsBasic } from "../gateway/agent-list.js";
import { pathExists } from "../infra/fs-safe.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";

export type AgentLocalStatus = {
  id: string;
  name?: string;
  workspaceDir: string | null;
  bootstrapPending: boolean | null;
  sessionsDatabasePath: string;
  sessionsCount: number;
  lastUpdatedAt: number | null;
  lastActiveAgeMs: number | null;
};

type AgentLocalStatusesResult = {
  defaultId: string;
  agents: AgentLocalStatus[];
  totalSessions: number;
  bootstrapPendingCount: number;
};

function listStatusSessionEntries(agentId: string): ReturnType<typeof listSessionEntries> {
  try {
    return listSessionEntries({ agentId });
  } catch {
    return [];
  }
}

export async function getAgentLocalStatuses(
  cfg: OpenClawConfig,
): Promise<AgentLocalStatusesResult> {
  const agentList = listGatewayAgentsBasic(cfg);
  const now = Date.now();

  const statuses: AgentLocalStatus[] = [];
  for (const agent of agentList.agents) {
    const agentId = agent.id;
    const workspaceDir = (() => {
      try {
        return resolveAgentWorkspaceDir(cfg, agentId);
      } catch {
        return null;
      }
    })();

    const bootstrapPath = workspaceDir != null ? path.join(workspaceDir, "BOOTSTRAP.md") : null;
    const bootstrapPending = bootstrapPath != null ? await pathExists(bootstrapPath) : null;

    const sessionsDatabasePath = resolveOpenClawAgentSqlitePath({ agentId });
    const sessions = listStatusSessionEntries(agentId)
      .filter((row) => row.sessionKey !== "global" && row.sessionKey !== "unknown")
      .map((row) => row.entry);
    const sessionsCount = sessions.length;
    const lastUpdatedAt = sessions.reduce((max, e) => Math.max(max, e?.updatedAt ?? 0), 0);
    const resolvedLastUpdatedAt = lastUpdatedAt > 0 ? lastUpdatedAt : null;
    const lastActiveAgeMs = resolvedLastUpdatedAt ? now - resolvedLastUpdatedAt : null;

    statuses.push({
      id: agentId,
      name: agent.name,
      workspaceDir,
      bootstrapPending,
      sessionsDatabasePath,
      sessionsCount,
      lastUpdatedAt: resolvedLastUpdatedAt,
      lastActiveAgeMs,
    });
  }

  const totalSessions = statuses.reduce((sum, s) => sum + s.sessionsCount, 0);
  const bootstrapPendingCount = statuses.reduce((sum, s) => sum + (s.bootstrapPending ? 1 : 0), 0);
  return {
    defaultId: agentList.defaultId,
    agents: statuses,
    totalSessions,
    bootstrapPendingCount,
  };
}
