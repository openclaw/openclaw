import { useCallback } from "react";
import { useVisualizeStore, type AgentActivity, type TeamRunEntry } from "@/store/visualize-store";
import type { AgentListResult } from "@/types/agents";
import { useGateway } from "./use-gateway";

type SessionEntry = {
  key: string;
  agentId?: string;
  state?: string;
  [key: string]: unknown;
};

type SessionsListResult = {
  sessions: SessionEntry[];
};

type TeamRunMember = {
  agentId: string;
  [key: string]: unknown;
};

type TeamRunRpcEntry = {
  id: string;
  name: string;
  leader: string;
  members: TeamRunMember[];
  state: string;
  [key: string]: unknown;
};

type TeamRunsListResult = {
  teams: TeamRunRpcEntry[];
};

export function useVisualize() {
  const { sendRpc } = useGateway();
  const store = useVisualizeStore();

  const loadAgents = useCallback(async () => {
    try {
      const result = await sendRpc<AgentListResult>("agents.list");
      useVisualizeStore.getState().syncAgents(result.agents);
    } catch (err) {
      console.error("[visualize] failed to load agents:", err);
    }
  }, [sendRpc]);

  const pollTeamRuns = useCallback(async () => {
    try {
      const result = await sendRpc<TeamRunsListResult>("teamRuns.list", { state: "active" });
      const teams: TeamRunEntry[] = (result.teams ?? []).map((t) => ({
        id: t.id,
        name: t.name,
        leader: t.leader,
        memberAgentIds: (t.members ?? []).map((m) => m.agentId),
        state: t.state,
      }));
      useVisualizeStore.getState().setActiveTeams(teams);
    } catch (err) {
      console.error("[visualize] failed to poll team runs:", err);
    }
  }, [sendRpc]);

  const pollSessions = useCallback(async () => {
    try {
      const result = await sendRpc<SessionsListResult>("sessions.list", { limit: 50 });
      const activeAgentIds = new Set<string>();
      for (const session of result.sessions ?? []) {
        if (session.agentId && session.state === "running") {
          activeAgentIds.add(session.agentId);
        }
      }

      const vizStore = useVisualizeStore.getState();
      const updated: Record<string, AgentActivity> = { ...vizStore.agentActivity };
      for (const agent of vizStore.agents) {
        if (activeAgentIds.has(agent.agentId)) {
          if (!updated[agent.agentId] || updated[agent.agentId] === "idle") {
            updated[agent.agentId] = "thinking";
          }
        } else {
          updated[agent.agentId] = "idle";
        }
      }

      useVisualizeStore.setState({ agentActivity: updated });
    } catch (err) {
      console.error("[visualize] failed to poll sessions:", err);
    }
  }, [sendRpc]);

  return {
    loadAgents,
    pollSessions,
    pollTeamRuns,
    isActive: store.isActive,
    agents: store.agents,
    agentActivity: store.agentActivity,
    selectedAgentId: store.selectedAgentId,
    zoom: store.zoom,
    totalActiveCount: store.totalActiveCount,
    totalTokens: store.totalTokens,
  };
}
