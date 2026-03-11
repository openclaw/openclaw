import {
  compileOperatorAgentRegistry,
  getCompiledOperatorTeam,
  type CompiledOperatorAgentRecord,
  type CompiledOperatorTeamRecord,
} from "./agent-registry.js";
import { taskEnvelopeSchema, type OperatorTaskEnvelope } from "./contracts.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function hasExplicitTransport(input: unknown): boolean {
  const record = asRecord(input);
  const execution = record ? asRecord(record.execution) : null;
  return Boolean(
    execution && typeof execution.transport === "string" && execution.transport.trim().length > 0,
  );
}

function scoreAgentForCapability(agent: CompiledOperatorAgentRecord, capability: string): number {
  const needle = normalize(capability);
  const triggers = agent.triggers.map(normalize);
  if (triggers.includes(needle)) {
    return 100;
  }
  if (triggers.some((entry) => entry.includes(needle) || needle.includes(entry))) {
    return 60;
  }
  const specialty = normalize(agent.specialty ?? "");
  if (specialty.includes(needle)) {
    return 40;
  }

  const needleTokens = needle.split(/[^a-z0-9]+/u).filter(Boolean);
  const triggerTokenHits = triggers.reduce((count, entry) => {
    const tokens = new Set(entry.split(/[^a-z0-9]+/u).filter(Boolean));
    return count + needleTokens.filter((token) => tokens.has(token)).length;
  }, 0);
  return triggerTokenHits * 10;
}

function resolveRecommendedAlias(
  team: CompiledOperatorTeamRecord,
  agents: CompiledOperatorAgentRecord[],
  capability: string,
): string | null {
  const candidates = agents.filter((entry) =>
    team.members.some((memberId) => normalize(memberId) === normalize(entry.id)),
  );
  if (candidates.length === 0) {
    return null;
  }

  const ranked = candidates
    .map((agent) => ({
      agent,
      score: scoreAgentForCapability(agent, capability),
    }))
    .toSorted(
      (left, right) => right.score - left.score || left.agent.name.localeCompare(right.agent.name),
    );

  if (ranked[0]?.score && ranked[0].score > 0) {
    return ranked[0].agent.id;
  }
  if (team.leadKind === "agent" && team.lead) {
    return team.lead;
  }
  return candidates[0]?.id ?? null;
}

export function resolveOperatorTaskEnvelope(input: unknown): OperatorTaskEnvelope {
  const parsed = taskEnvelopeSchema.parse(input);
  const teamId = parsed.target.team_id?.trim() || null;
  if (!teamId) {
    return parsed;
  }

  const registry = compileOperatorAgentRegistry();
  const team = getCompiledOperatorTeam(teamId);
  if (!team) {
    throw new Error(`unknown operator team: ${teamId}`);
  }

  const next: OperatorTaskEnvelope = {
    ...parsed,
    target: {
      ...parsed.target,
      team_id: team.id,
    },
    execution: {
      ...parsed.execution,
    },
  };

  if (next.target.alias) {
    const aliasInTeam = team.members.some(
      (entry) => normalize(entry) === normalize(next.target.alias ?? ""),
    );
    if (!aliasInTeam) {
      throw new Error(`target alias ${next.target.alias} is not a member of team ${team.id}`);
    }
  } else {
    next.target.alias = resolveRecommendedAlias(team, registry.agents, next.target.capability);
  }

  if (!hasExplicitTransport(input) && team.dispatchTransport) {
    next.execution.transport =
      team.dispatchTransport as OperatorTaskEnvelope["execution"]["transport"];
  }

  return next;
}

export function getResolvedOperatorTaskTeam(
  task: Pick<OperatorTaskEnvelope, "target">,
): CompiledOperatorTeamRecord | null {
  const teamId = task.target.team_id?.trim();
  if (!teamId) {
    return null;
  }
  return getCompiledOperatorTeam(teamId);
}
