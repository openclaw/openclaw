// This never contacts the gateway; it inspects configured agents and their read-only session stores.

import path from "node:path";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { measureCliCommandStartup } from "../cli/command-startup-timing.js";
import type { OpenClawConfig } from "../config/types.js";
import { listGatewayAgentsBasic } from "../gateway/agent-list.js";
import { pathExists } from "../infra/fs-safe.js";
import {
  evaluateAgentDatabaseAdmissions,
  hasAgentDatabaseAdmissions,
  recordAgentDatabaseAdmissions,
  type AgentDatabaseAdmissionRefusal,
} from "../state/agent-database-admission.js";
import {
  prepareStatusSessionStores,
  STATUS_RECENT_SESSION_LIMIT,
  type StatusSessionStores,
} from "../status/session-stores.js";

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

export type PreparedStatusLocalSnapshot = Awaited<ReturnType<typeof collectStatusLocalSnapshot>>;
export type AgentLocalStatusesResult = ReturnType<PreparedStatusLocalSnapshot["publish"]>;

/** Prepares local workspace and session facts for a final synchronous publication. */
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
  const agentList = await listGatewayAgentsBasic(cfg);
  const now = Date.now();

  const sessionStores = await measureCliCommandStartup(
    "status.session-stores",
    () => prepareStatusSessionStores(cfg, agentList.agents, STATUS_RECENT_SESSION_LIMIT),
    { config: cfg },
  );
  const workspaces = new Map<
    string,
    { workspaceDir: string | null; bootstrapPending: boolean | null }
  >();
  for (const agent of agentList.agents) {
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

    workspaces.set(agentId, { workspaceDir, bootstrapPending });
  }
  const defaultId = agentList.selectionRequired ? null : agentList.defaultId;
  return {
    defaultId,
    sessionStores,
    publish(published: StatusSessionStores = sessionStores.publish()) {
      const statuses: AgentLocalStatus[] = published.byAgent.map(
        ({ agent, path: sessionsPath, count, recent }) => {
          const lastUpdatedAt = recent[0]?.entry.updatedAt ?? 0;
          const resolvedLastUpdatedAt = lastUpdatedAt > 0 ? lastUpdatedAt : null;
          return {
            id: agent.id,
            ...(agent.admissionRefusal
              ? { status: agent.status, admissionRefusal: agent.admissionRefusal }
              : {}),
            name: agent.name,
            ...workspaces.get(agent.id)!,
            sessionsPath,
            sessionsCount: count,
            lastUpdatedAt: resolvedLastUpdatedAt,
            lastActiveAgeMs: resolvedLastUpdatedAt ? now - resolvedLastUpdatedAt : null,
          };
        },
      );

      const bootstrapPendingCount = statuses.reduce(
        (sum, s) => sum + (s.bootstrapPending ? 1 : 0),
        0,
      );
      return {
        // Keep explicit fleets unselected; the prepared default still owns local inspection.
        defaultId: defaultId
          ? ((statuses.find(({ id }) => id === defaultId) ?? statuses[0])?.id ?? null)
          : null,
        ownership: agentList.ownership,
        selectionRequired: agentList.selectionRequired,
        agents: statuses,
        totalSessions: published.count,
        bootstrapPendingCount,
      };
    },
  };
}
