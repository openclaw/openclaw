import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SkillStatusReport } from "../../api/types.ts";
import type { RuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { isWorkshopSkill } from "../../lib/skills-shared.ts";
import { loadSkillStatusReport } from "../../lib/skills/status-report.ts";

export type AgentSkillsState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  requestGeneration: number;
  agentSkillsLoading: boolean;
  agentSkillsError: string | null;
  agentSkillsReport: SkillStatusReport | null;
  agentSkillsAgentId: string | null;
};

export async function loadAgentSkills(state: AgentSkillsState, agentId: string) {
  const client = state.client;
  if (!client || !state.connected || state.agentSkillsLoading) {
    return;
  }
  const generation = state.requestGeneration;
  const isCurrent = () =>
    state.client === client && state.connected && state.requestGeneration === generation;
  state.agentSkillsLoading = true;
  state.agentSkillsError = null;
  try {
    const res = await loadSkillStatusReport(client, agentId);
    if (res && isCurrent()) {
      state.agentSkillsReport = res;
      state.agentSkillsAgentId = agentId;
    }
  } catch (err) {
    if (isCurrent()) {
      state.agentSkillsError = formatUiError(err);
    }
  } finally {
    if (isCurrent()) {
      state.agentSkillsLoading = false;
    }
  }
}

/**
 * Allowlist after toggling one skill. Without an existing filter, the first toggle snapshots
 * the reported skills, leaving out learned Workshop skills: they bypass allowlists.
 */
export function nextAgentSkillAllowlist(params: {
  configured: string[] | undefined;
  report: SkillStatusReport | null;
  skillName: string;
  enabled: boolean;
}): string[] {
  const next = new Set(
    params.configured ??
      params.report?.agentSkillFilter ??
      params.report?.skills
        .filter((skill) => skill.name && !isWorkshopSkill(skill))
        .map((skill) => skill.name) ??
      [],
  );
  if (params.enabled) {
    next.add(params.skillName);
  } else {
    next.delete(params.skillName);
  }
  return [...next];
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
