import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SkillStatusReport } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
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

async function clearAgentSkillFilter(
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

export function createAgentSkillsReset(options: {
  state: AgentSkillsState;
  context: Pick<ApplicationContext, "agents" | "runtimeConfig">;
  canReset: () => boolean;
  isCurrent: (
    client: GatewayBrowserClient,
    generation: number,
    agentId: string,
    agents: ApplicationContext["agents"],
  ) => boolean;
  onUpdated: (agentId: string) => void;
  retired: () => Promise<void>;
}) {
  return {
    clear(agentId: string) {
      if (!options.canReset()) {
        return undefined;
      }
      const { state, context } = options;
      const client = state.client;
      const generation = state.requestGeneration;
      const agents = context.agents;
      const runtimeConfig = context.runtimeConfig;
      if (!client) {
        return undefined;
      }
      const canDispatch = () =>
        context.runtimeConfig === runtimeConfig &&
        options.isCurrent(client, generation, agentId, agents) &&
        options.canReset();
      if (!canDispatch()) {
        return undefined;
      }
      const retirement = options.retired();
      const completion = clearAgentSkillFilter(runtimeConfig, agentId, canDispatch).then(
        (updated) => {
          if (!canDispatch()) {
            return;
          }
          if (!updated) {
            throw new Error(runtimeConfig.state.lastError ?? t("agents.skillsPanel.updateError"));
          }
          options.onUpdated(agentId);
        },
      );
      // Retire presentation synchronously; the config owner still records the write outcome.
      return Promise.race([completion, retirement]);
    },
  };
}
