import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SkillStatusReport } from "../../api/types.ts";
import type { RuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { loadSkillStatusReport } from "../../lib/skills/status-report.ts";

type AgentSkillsRead = {
  agentId: string;
  result: Promise<SkillStatusReport | undefined>;
};

export type AgentSkillsState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  requestGeneration: number;
  agentSkillsRead: AgentSkillsRead | null;
  agentSkillsUpdateError: string | null;
  agentSkillsReport: SkillStatusReport | null;
  agentSkillsAgentId: string | null;
};

export function createAgentSkillsReader(state: AgentSkillsState) {
  let pending: AgentSkillsRead["result"] | null = null;
  return {
    refresh(agentId: string) {
      if (!state.client || !state.connected || pending) {
        return;
      }
      state.agentSkillsUpdateError = null;
      const result = readAgentSkills(state, agentId);
      pending = result;
      state.agentSkillsRead = { agentId, result };
      // The page issues reads before the panel mounts; Errored owns their visible failure.
      void result
        .finally(() => {
          if (pending === result) {
            pending = null;
          }
        })
        .catch(() => {});
    },
    reset() {
      pending = null;
      state.agentSkillsRead = null;
    },
  };
}

async function readAgentSkills(
  state: AgentSkillsState,
  agentId: string,
): Promise<SkillStatusReport | undefined> {
  const client = state.client;
  if (!client || !state.connected) {
    return undefined;
  }
  const generation = state.requestGeneration;
  const isCurrent = () =>
    state.client === client && state.connected && state.requestGeneration === generation;
  const report = await loadSkillStatusReport(client, agentId);
  if (!isCurrent()) {
    return undefined;
  }
  if (report) {
    state.agentSkillsReport = report;
    state.agentSkillsAgentId = agentId;
  }
  return report;
}

export async function clearAgentSkillFilter(
  runtimeConfig: RuntimeConfigCapability,
  agentId: string,
  canDispatch: () => boolean = () => true,
): Promise<boolean> {
  const target = runtimeConfig.agentEntry(agentId);
  if (!target || !Array.isArray(target.entry.skills) || !canDispatch()) {
    return false;
  }
  const targetKey = target.path[2];
  if (typeof targetKey !== "string") {
    return false;
  }
  return runtimeConfig.patch({
    raw: {
      agents: {
        entries: {
          [targetKey]: { skills: null },
        },
      },
    },
    note: "Reset agent skills to inherited defaults",
    replacePaths: [`agents.entries.${targetKey}.skills`],
    canDispatch,
  });
}
