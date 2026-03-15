import {
  compileOperatorAgentRegistry,
  type CompiledOperatorAgentRecord,
  type CompiledOperatorAgentRegistry,
  type CompiledOperatorIdentityRecord,
  type CompiledOperatorTeamRecord,
} from "./agent-registry.js";

export type SpecialistRuntimePreference = "subagent" | "acp" | "any";

export type SpecialistSelectorInput = {
  agentId?: string | null;
  teamId?: string | null;
  capability?: string | null;
  role?: string | null;
  explicitAlias?: string | null;
  requesterId?: string | null;
  runtimePreference?: SpecialistRuntimePreference;
  activeSessionsByIdentityId?: ReadonlyMap<string, number>;
  activeSessionsByTeamId?: ReadonlyMap<string, number>;
  registry?: CompiledOperatorAgentRegistry;
};

export type ResolvedSpecialistTarget = {
  identityId: string;
  kind: "agent" | "runtime";
  teamId: string | null;
  capability: string | null;
  roleAliasUsed: boolean;
  leadRouted: boolean;
  maxConcurrentSessions: number;
  teamMaxParallel: number | null;
  allowedTeamIds: string[];
};

export type VisibleSpecialistTeamMember = {
  id: string;
  kind: "agent" | "runtime";
  name: string;
  role: string | null;
  capabilities: string[];
  configured: boolean;
  maxConcurrentSessions: number;
};

export type VisibleSpecialistTeam = {
  id: string;
  name: string;
  parentTeamId: string | null;
  ancestorTeamIds: string[];
  descendantTeamIds: string[];
  lead: string | null;
  leadKind: "agent" | "runtime" | "external" | null;
  routeViaLead: boolean;
  ownsCapabilities: string[];
  maxParallel: number | null;
  members: VisibleSpecialistTeamMember[];
};

type NormalizedSelector = {
  agentId: string | null;
  teamId: string | null;
  capability: string | null;
  roleAliasUsed: boolean;
  explicitAlias: string | null;
};

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function asTrimmedString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function createRegistry(params?: {
  registry?: CompiledOperatorAgentRegistry;
  allowMissingRegistry?: boolean;
}): CompiledOperatorAgentRegistry {
  if (params?.registry) {
    return params.registry;
  }
  try {
    return compileOperatorAgentRegistry();
  } catch (error) {
    if (
      params?.allowMissingRegistry === true &&
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return {
        schema: "OperatorAgentRegistryV1",
        generatedAt: Date.now(),
        sourcePath: "",
        sourceHash: "",
        agentCount: 0,
        teamCount: 0,
        operatorRuntime: {
          transports: {
            angelaHttp: {
              globalDefaultAlias: null,
            },
          },
        },
        agents: [],
        teams: [],
        pipelineOrder: [],
        skillOwnership: [],
        k8sCluster: [],
        identities: [],
      };
    }
    throw error;
  }
}

function getIdentityById(
  registry: CompiledOperatorAgentRegistry,
  id: string,
): CompiledOperatorIdentityRecord | null {
  const needle = normalize(id);
  return registry.identities.find((entry) => normalize(entry.id) === needle) ?? null;
}

function getTeamById(
  registry: CompiledOperatorAgentRegistry,
  teamId: string,
): CompiledOperatorTeamRecord | null {
  const needle = normalize(teamId);
  return registry.teams.find((entry) => normalize(entry.id) === needle) ?? null;
}

function getAgentById(
  registry: CompiledOperatorAgentRegistry,
  agentId: string,
): CompiledOperatorAgentRecord | null {
  const needle = normalize(agentId);
  return registry.agents.find((entry) => normalize(entry.id) === needle) ?? null;
}

function matchesRuntimePreference(
  identity: CompiledOperatorIdentityRecord | null,
  runtimePreference: SpecialistRuntimePreference,
): boolean {
  if (runtimePreference === "any" || runtimePreference === "acp") {
    return true;
  }
  return identity?.kind === "agent";
}

function normalizeSelectorInput(input: SpecialistSelectorInput): NormalizedSelector {
  const agentId = asTrimmedString(input.agentId);
  const teamId = asTrimmedString(input.teamId);
  const capability = asTrimmedString(input.capability);
  const role = asTrimmedString(input.role);
  const explicitAlias = asTrimmedString(input.explicitAlias);

  if (agentId && (teamId || capability || role)) {
    throw new Error("agentId cannot be combined with teamId, capability, or role");
  }
  if ((capability || role) && !teamId) {
    throw new Error("capability/role requires teamId");
  }
  if (capability && role && normalize(capability) !== normalize(role)) {
    throw new Error("capability and role must match when both are provided");
  }

  return {
    agentId,
    teamId,
    capability: capability ?? role,
    roleAliasUsed: !capability && Boolean(role),
    explicitAlias,
  };
}

function scoreTokenOverlap(haystack: string[], capability: string): number {
  const needleTokens = capability.split(/[^a-z0-9]+/u).filter(Boolean);
  if (needleTokens.length === 0) {
    return 0;
  }
  return haystack.reduce((score, entry) => {
    const tokens = new Set(entry.split(/[^a-z0-9]+/u).filter(Boolean));
    return score + needleTokens.filter((token) => tokens.has(token)).length * 10;
  }, 0);
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
  return scoreTokenOverlap(triggers, needle);
}

function scoreIdentityForCapability(params: {
  registry: CompiledOperatorAgentRegistry;
  identity: CompiledOperatorIdentityRecord;
  team: CompiledOperatorTeamRecord;
  capability: string;
}): number {
  const needle = normalize(params.capability);
  const agent = getAgentById(params.registry, params.identity.id);
  if (agent) {
    return scoreAgentForCapability(agent, needle);
  }

  const identityCapabilities = params.identity.capabilities.map(normalize);
  if (identityCapabilities.includes(needle)) {
    return 90;
  }
  if (
    params.team.ownsCapabilities.map(normalize).includes(needle) ||
    identityCapabilities.some((entry) => entry.includes(needle) || needle.includes(entry))
  ) {
    return 45;
  }
  return scoreTokenOverlap(identityCapabilities, needle);
}

function getActiveSessionsCount(map: ReadonlyMap<string, number> | undefined, id: string): number {
  return map?.get(id) ?? 0;
}

function resolveAllowedTeamIds(
  registry: CompiledOperatorAgentRegistry,
  requesterId: string | null | undefined,
): string[] {
  const normalizedRequesterId = asTrimmedString(requesterId);
  if (!normalizedRequesterId) {
    return registry.teams.map((team) => team.id);
  }

  const identity = getIdentityById(registry, normalizedRequesterId);
  if (!identity) {
    return [];
  }
  const allowed = new Set<string>(identity.teamIds);
  for (const leadTeamId of identity.leadTeamIds) {
    allowed.add(leadTeamId);
    const team = getTeamById(registry, leadTeamId);
    for (const descendantId of team?.descendantTeamIds ?? []) {
      allowed.add(descendantId);
    }
  }
  return Array.from(allowed).toSorted((left, right) => left.localeCompare(right));
}

function buildVisibleMember(params: {
  registry: CompiledOperatorAgentRegistry;
  identityId: string;
  configuredAgentIds: ReadonlySet<string>;
}): VisibleSpecialistTeamMember | null {
  const identity = getIdentityById(params.registry, params.identityId);
  if (!identity) {
    return null;
  }
  return {
    id: identity.id,
    kind: identity.kind,
    name: identity.name,
    role: identity.role,
    capabilities: identity.capabilities,
    configured: identity.kind === "agent" && params.configuredAgentIds.has(normalize(identity.id)),
    maxConcurrentSessions: identity.maxConcurrentSessions,
  };
}

export function listVisibleSpecialistTeams(params: {
  requesterId?: string | null;
  configuredAgentIds?: Iterable<string>;
  registry?: CompiledOperatorAgentRegistry;
}): VisibleSpecialistTeam[] {
  const registry = createRegistry({ ...params, allowMissingRegistry: true });
  const configuredAgentIds = new Set(
    Array.from(params.configuredAgentIds ?? [], (value) => normalize(value)),
  );
  const allowedTeamIds = new Set(resolveAllowedTeamIds(registry, params.requesterId));

  return registry.teams
    .filter((team) => allowedTeamIds.has(team.id))
    .toSorted((left, right) => left.id.localeCompare(right.id))
    .map((team) => ({
      id: team.id,
      name: team.name,
      parentTeamId: team.parentTeamId,
      ancestorTeamIds: [...team.ancestorTeamIds],
      descendantTeamIds: [...team.descendantTeamIds],
      lead: team.lead,
      leadKind: team.leadKind,
      routeViaLead: team.routeViaLead,
      ownsCapabilities: Array.from(
        new Set(
          [
            ...team.ownsCapabilities,
            ...team.memberIdentityIds.flatMap(
              (id) => getIdentityById(registry, id)?.capabilities ?? [],
            ),
          ].filter(Boolean),
        ),
      ).toSorted((left, right) => left.localeCompare(right)),
      maxParallel: team.maxParallel,
      members: team.memberIdentityIds
        .map((id) => buildVisibleMember({ registry, identityId: id, configuredAgentIds }))
        .filter((entry): entry is VisibleSpecialistTeamMember => Boolean(entry))
        .toSorted((left, right) => left.id.localeCompare(right.id)),
    }));
}

export function resolveSpecialistTarget(input: SpecialistSelectorInput): ResolvedSpecialistTarget {
  const registry = createRegistry(input);
  const runtimePreference = input.runtimePreference ?? "any";
  const selector = normalizeSelectorInput(input);
  const allowedTeamIds = resolveAllowedTeamIds(registry, input.requesterId);

  if (selector.agentId) {
    const identity = getIdentityById(registry, selector.agentId);
    if (identity && !matchesRuntimePreference(identity, runtimePreference)) {
      throw new Error(`agentId ${selector.agentId} cannot satisfy runtime=${runtimePreference}`);
    }
    return {
      identityId: selector.agentId,
      kind: identity?.kind ?? "agent",
      teamId: null,
      capability: null,
      roleAliasUsed: false,
      leadRouted: false,
      maxConcurrentSessions: identity?.maxConcurrentSessions ?? 1,
      teamMaxParallel: null,
      allowedTeamIds,
    };
  }

  if (!selector.teamId || !selector.capability) {
    throw new Error("teamId and capability/role are required for team-based routing");
  }
  const capability = selector.capability;

  const team = getTeamById(registry, selector.teamId);
  if (!team) {
    throw new Error(`unknown operator team: ${selector.teamId}`);
  }
  if (input.requesterId && !allowedTeamIds.includes(team.id)) {
    throw new Error(`team ${team.id} is outside the caller scope`);
  }

  if (selector.explicitAlias) {
    const identity = getIdentityById(registry, selector.explicitAlias);
    const aliasInTeam = team.memberIdentityIds.some(
      (entry) => normalize(entry) === normalize(selector.explicitAlias ?? ""),
    );
    if (!aliasInTeam) {
      throw new Error(`target alias ${selector.explicitAlias} is not a member of team ${team.id}`);
    }
    if (!matchesRuntimePreference(identity, runtimePreference)) {
      throw new Error(
        `target alias ${selector.explicitAlias} cannot satisfy runtime=${runtimePreference}`,
      );
    }
    return {
      identityId: selector.explicitAlias,
      kind: identity?.kind ?? "agent",
      teamId: team.id,
      capability: selector.capability,
      roleAliasUsed: selector.roleAliasUsed,
      leadRouted: false,
      maxConcurrentSessions: identity?.maxConcurrentSessions ?? 1,
      teamMaxParallel: team.maxParallel,
      allowedTeamIds,
    };
  }

  if (team.routeViaLead && team.lead) {
    const lead = getIdentityById(registry, team.lead);
    if (!matchesRuntimePreference(lead, runtimePreference)) {
      throw new Error(
        `team ${team.id} routes via lead ${team.lead}, but the lead cannot satisfy runtime=${runtimePreference}`,
      );
    }
    if (
      team.maxParallel &&
      getActiveSessionsCount(input.activeSessionsByTeamId, team.id) >= team.maxParallel
    ) {
      throw new Error(`team ${team.id} has reached max parallel capacity (${team.maxParallel})`);
    }
    if (
      getActiveSessionsCount(input.activeSessionsByIdentityId, team.lead) >=
      (lead?.maxConcurrentSessions ?? 1)
    ) {
      throw new Error(`specialist ${team.lead} has reached max concurrent sessions`);
    }
    return {
      identityId: team.lead,
      kind: lead?.kind ?? "agent",
      teamId: team.id,
      capability: selector.capability,
      roleAliasUsed: selector.roleAliasUsed,
      leadRouted: true,
      maxConcurrentSessions: lead?.maxConcurrentSessions ?? 1,
      teamMaxParallel: team.maxParallel,
      allowedTeamIds,
    };
  }

  if (
    team.maxParallel &&
    getActiveSessionsCount(input.activeSessionsByTeamId, team.id) >= team.maxParallel
  ) {
    throw new Error(`team ${team.id} has reached max parallel capacity (${team.maxParallel})`);
  }

  const candidates = team.memberIdentityIds
    .map((id) => getIdentityById(registry, id))
    .filter((identity): identity is CompiledOperatorIdentityRecord => Boolean(identity))
    .filter((identity) => matchesRuntimePreference(identity, runtimePreference));

  if (candidates.length === 0) {
    throw new Error(`team ${team.id} has no members that can satisfy runtime=${runtimePreference}`);
  }

  const available = candidates.filter(
    (identity) =>
      getActiveSessionsCount(input.activeSessionsByIdentityId, identity.id) <
      identity.maxConcurrentSessions,
  );
  if (available.length === 0) {
    throw new Error(`team ${team.id} has no available specialists for new work`);
  }

  const ranked = available
    .map((identity) => ({
      identity,
      score: scoreIdentityForCapability({
        registry,
        identity,
        team,
        capability,
      }),
      activeCount: getActiveSessionsCount(input.activeSessionsByIdentityId, identity.id),
      isLead: team.lead ? normalize(identity.id) === normalize(team.lead) : false,
    }))
    .toSorted(
      (left, right) =>
        right.score - left.score ||
        left.activeCount - right.activeCount ||
        Number(right.isLead) - Number(left.isLead) ||
        left.identity.id.localeCompare(right.identity.id),
    );

  const resolved = ranked[0];
  if (!resolved) {
    throw new Error(`team ${team.id} has no matching specialist for ${selector.capability}`);
  }

  return {
    identityId: resolved.identity.id,
    kind: resolved.identity.kind,
    teamId: team.id,
    capability,
    roleAliasUsed: selector.roleAliasUsed,
    leadRouted: resolved.isLead,
    maxConcurrentSessions: resolved.identity.maxConcurrentSessions,
    teamMaxParallel: team.maxParallel,
    allowedTeamIds,
  };
}

export function resolveRequesterVisibleTeamIds(params: {
  requesterId?: string | null;
  registry?: CompiledOperatorAgentRegistry;
}): string[] {
  return resolveAllowedTeamIds(
    createRegistry({ ...params, allowMissingRegistry: true }),
    params.requesterId,
  );
}
