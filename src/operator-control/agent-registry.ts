import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { resolveDefaultAgentId, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import { saveJsonFile } from "../infra/json-file.js";

export type CompiledOperatorAgentRecord = {
  id: string;
  name: string;
  role: string | null;
  specialty: string | null;
  model: string | null;
  skill: string | null;
  spawnTemplate: string | null;
  repos: string[];
  triggers: string[];
  notes: string | null;
  teams: string[];
};

export type CompiledOperatorSkillOwnership = {
  skill: string;
  owner: string;
  status: string | null;
  rationale: string | null;
};

export type CompiledOperatorK8sRecord = {
  id: string;
  name: string | null;
  role: string | null;
  namespace: string | null;
  status: string | null;
};

export type CompiledOperatorIdentityRecord = {
  id: string;
  kind: "agent" | "runtime";
  name: string;
  role: string | null;
  teamIds: string[];
  leadTeamIds: string[];
};

export type CompiledOperatorTeamRecord = {
  id: string;
  name: string;
  kind: string | null;
  lead: string | null;
  leadKind: "agent" | "runtime" | "external" | null;
  mission: string | null;
  members: string[];
  runtimeIds: string[];
  ownsCapabilities: string[];
  dispatchTransport: string | null;
  dispatchEndpointEnv: string | null;
  dispatchPath: string | null;
  dispatchAuthScheme: string | null;
  dispatchAuthEnv: string | null;
  routingPolicy: string | null;
  notes: string | null;
};

export type CompiledOperatorAgentRegistry = {
  schema: "OperatorAgentRegistryV1";
  generatedAt: number;
  sourcePath: string;
  sourceHash: string;
  agentCount: number;
  teamCount: number;
  agents: CompiledOperatorAgentRecord[];
  teams: CompiledOperatorTeamRecord[];
  pipelineOrder: string[];
  skillOwnership: CompiledOperatorSkillOwnership[];
  k8sCluster: CompiledOperatorK8sRecord[];
  identities: CompiledOperatorIdentityRecord[];
};

type RawAgentRegistry = {
  agents?: unknown;
  teams?: unknown;
  pipeline_order?: unknown;
  skill_ownership?: unknown;
  k8s_cluster?: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => asString(entry)).filter((entry): entry is string => Boolean(entry));
}

function ensureUnique(values: string[], label: string): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`Duplicate ${label}: ${value}`);
    }
    seen.add(key);
  }
  return values;
}

function resolveAgentsRegistrySourcePath(params?: {
  workspaceDir?: string;
  sourcePath?: string;
}): string {
  if (params?.sourcePath?.trim()) {
    return path.resolve(params.sourcePath);
  }
  const workspaceDir =
    params?.workspaceDir?.trim() ||
    resolveAgentWorkspaceDir(loadConfig(), resolveDefaultAgentId(loadConfig()));
  return path.join(workspaceDir, "memory", "reference", "agents.yaml");
}

function parseRawRegistry(sourcePath: string): RawAgentRegistry {
  const raw = fs.readFileSync(sourcePath, "utf8");
  const parsed = YAML.parse(raw, { schema: "core" }) as unknown;
  const record = asRecord(parsed);
  if (!record) {
    throw new Error(`Invalid agents registry at ${sourcePath}`);
  }
  return record as RawAgentRegistry;
}

function compileAgentRecord(entry: unknown): CompiledOperatorAgentRecord {
  const record = asRecord(entry);
  if (!record) {
    throw new Error("Invalid agent entry in agents.yaml");
  }
  const id = asString(record.id);
  if (!id) {
    throw new Error("Agent entry missing id");
  }
  return {
    id,
    name: asString(record.name) ?? id,
    role: asString(record.role) ?? asString(record.specialty),
    specialty: asString(record.specialty),
    model: asString(record.model_full) ?? asString(record.model),
    skill: asString(record.skill),
    spawnTemplate: asString(record.spawn_template),
    repos: asStringArray(record.repos),
    triggers: asStringArray(record.triggers),
    notes: asString(record.notes),
    teams: [],
  };
}

function compileTeamRecord(entry: unknown): CompiledOperatorTeamRecord {
  const record = asRecord(entry);
  if (!record) {
    throw new Error("Invalid team entry in agents.yaml");
  }
  const id = asString(record.id);
  if (!id) {
    throw new Error("Team entry missing id");
  }
  return {
    id,
    name: asString(record.name) ?? id,
    kind: asString(record.kind),
    lead: asString(record.lead),
    leadKind: null,
    mission: asString(record.mission),
    members: asStringArray(record.members),
    runtimeIds: asStringArray(record.runtime_ids),
    ownsCapabilities: asStringArray(record.owns_capabilities),
    dispatchTransport: asString(record.dispatch_transport),
    dispatchEndpointEnv: asString(record.dispatch_endpoint_env),
    dispatchPath: asString(record.dispatch_path),
    dispatchAuthScheme: asString(record.dispatch_auth_scheme),
    dispatchAuthEnv: asString(record.dispatch_auth_env),
    routingPolicy: asString(record.routing_policy),
    notes: asString(record.notes),
  };
}

function compileSkillOwnership(entry: unknown): CompiledOperatorSkillOwnership {
  const record = asRecord(entry);
  if (!record) {
    throw new Error("Invalid skill_ownership entry in agents.yaml");
  }
  const skill = asString(record.skill);
  const owner = asString(record.owner);
  if (!skill || !owner) {
    throw new Error("skill_ownership entry must include skill and owner");
  }
  return {
    skill,
    owner,
    status: asString(record.status),
    rationale: asString(record.rationale),
  };
}

function compileK8sRecord(entry: unknown): CompiledOperatorK8sRecord {
  const record = asRecord(entry);
  if (!record) {
    throw new Error("Invalid k8s_cluster entry in agents.yaml");
  }
  const id = asString(record.id);
  if (!id) {
    throw new Error("k8s_cluster entry missing id");
  }
  return {
    id,
    name: asString(record.name),
    role: asString(record.role),
    namespace: asString(record.namespace),
    status: asString(record.status),
  };
}

function resolveRegistryArtifactPath(): string {
  return path.join(resolveStateDir(), "mission-control", "operator-agent-registry.json");
}

function buildIdentityDirectory(params: {
  agents: CompiledOperatorAgentRecord[];
  teams: CompiledOperatorTeamRecord[];
  k8sCluster: CompiledOperatorK8sRecord[];
}): CompiledOperatorIdentityRecord[] {
  const teamIdsByAgent = new Map<string, string[]>();
  const leadTeamIdsByAgent = new Map<string, string[]>();
  const teamIdsByRuntime = new Map<string, string[]>();
  const leadTeamIdsByRuntime = new Map<string, string[]>();

  for (const team of params.teams) {
    for (const member of team.members) {
      const key = member.toLowerCase();
      const current = teamIdsByAgent.get(key) ?? [];
      if (!current.includes(team.id)) {
        current.push(team.id);
      }
      teamIdsByAgent.set(key, current);
    }

    for (const runtimeId of team.runtimeIds) {
      const key = runtimeId.toLowerCase();
      const current = teamIdsByRuntime.get(key) ?? [];
      if (!current.includes(team.id)) {
        current.push(team.id);
      }
      teamIdsByRuntime.set(key, current);
    }

    if (!team.lead) {
      continue;
    }

    const leadKey = team.lead.toLowerCase();
    if (team.members.some((member) => member.toLowerCase() === leadKey)) {
      const current = leadTeamIdsByAgent.get(leadKey) ?? [];
      if (!current.includes(team.id)) {
        current.push(team.id);
      }
      leadTeamIdsByAgent.set(leadKey, current);
    }

    if (team.runtimeIds.some((runtimeId) => runtimeId.toLowerCase() === leadKey)) {
      const current = leadTeamIdsByRuntime.get(leadKey) ?? [];
      if (!current.includes(team.id)) {
        current.push(team.id);
      }
      leadTeamIdsByRuntime.set(leadKey, current);
    }
  }

  const identities: CompiledOperatorIdentityRecord[] = [
    ...params.agents.map((agent) => ({
      id: agent.id,
      kind: "agent" as const,
      name: agent.name,
      role: agent.role,
      teamIds: teamIdsByAgent.get(agent.id.toLowerCase()) ?? [],
      leadTeamIds: leadTeamIdsByAgent.get(agent.id.toLowerCase()) ?? [],
    })),
    ...params.k8sCluster.map((runtime) => ({
      id: runtime.id,
      kind: "runtime" as const,
      name: runtime.name ?? runtime.id,
      role: runtime.role,
      teamIds: teamIdsByRuntime.get(runtime.id.toLowerCase()) ?? [],
      leadTeamIds: leadTeamIdsByRuntime.get(runtime.id.toLowerCase()) ?? [],
    })),
  ];

  return identities.toSorted((left, right) => left.id.localeCompare(right.id));
}

export function compileOperatorAgentRegistry(params?: {
  workspaceDir?: string;
  sourcePath?: string;
}): CompiledOperatorAgentRegistry {
  const sourcePath = resolveAgentsRegistrySourcePath(params);
  const rawYaml = fs.readFileSync(sourcePath, "utf8");
  const parsed = parseRawRegistry(sourcePath);
  const compiledAgents = (Array.isArray(parsed.agents) ? parsed.agents : []).map(
    compileAgentRecord,
  );
  ensureUnique(
    compiledAgents.map((entry) => entry.id),
    "agent id",
  );
  const agentIds = new Set(compiledAgents.map((entry) => entry.id.toLowerCase()));
  const compiledTeams = (Array.isArray(parsed.teams) ? parsed.teams : []).map(compileTeamRecord);
  ensureUnique(
    compiledTeams.map((entry) => entry.id),
    "team id",
  );

  const pipelineOrder = ensureUnique(
    asStringArray(parsed.pipeline_order).map((entry) => entry.trim()),
    "pipeline_order entry",
  );
  for (const entry of pipelineOrder) {
    if (!agentIds.has(entry.toLowerCase())) {
      throw new Error(`pipeline_order references unknown agent: ${entry}`);
    }
  }

  const skillOwnership = (Array.isArray(parsed.skill_ownership) ? parsed.skill_ownership : []).map(
    compileSkillOwnership,
  );
  for (const entry of skillOwnership) {
    if (!agentIds.has(entry.owner.toLowerCase())) {
      throw new Error(`skill_ownership references unknown owner: ${entry.owner}`);
    }
  }

  const k8sCluster = (Array.isArray(parsed.k8s_cluster) ? parsed.k8s_cluster : []).map(
    compileK8sRecord,
  );
  const k8sIds = new Set(k8sCluster.map((entry) => entry.id.toLowerCase()));
  const agentsById = new Map(compiledAgents.map((entry) => [entry.id.toLowerCase(), entry]));
  for (const team of compiledTeams) {
    if (team.lead) {
      const leadKey = team.lead.toLowerCase();
      if (agentIds.has(leadKey)) {
        team.leadKind = "agent";
      } else if (k8sIds.has(leadKey)) {
        team.leadKind = "runtime";
      } else {
        throw new Error(`team references unknown lead: ${team.lead}`);
      }
    }
    for (const memberId of team.members) {
      const agent = agentsById.get(memberId.toLowerCase());
      if (!agent) {
        throw new Error(`team references unknown member: ${memberId}`);
      }
      if (!agent.teams.includes(team.id)) {
        agent.teams.push(team.id);
      }
    }
    for (const runtimeId of team.runtimeIds) {
      if (!k8sIds.has(runtimeId.toLowerCase())) {
        throw new Error(`team references unknown runtime_id: ${runtimeId}`);
      }
    }
  }
  const snapshot: CompiledOperatorAgentRegistry = {
    schema: "OperatorAgentRegistryV1",
    generatedAt: Date.now(),
    sourcePath,
    sourceHash: createHash("sha256").update(rawYaml).digest("hex"),
    agentCount: compiledAgents.length,
    teamCount: compiledTeams.length,
    agents: compiledAgents,
    teams: compiledTeams,
    pipelineOrder,
    skillOwnership,
    k8sCluster,
    identities: buildIdentityDirectory({
      agents: compiledAgents,
      teams: compiledTeams,
      k8sCluster,
    }),
  };
  saveJsonFile(resolveRegistryArtifactPath(), snapshot);
  return snapshot;
}

export function getCompiledOperatorTeam(
  teamId: string,
  params?: {
    workspaceDir?: string;
    sourcePath?: string;
  },
): CompiledOperatorTeamRecord | null {
  const registry = compileOperatorAgentRegistry(params);
  return (
    registry.teams.find((entry) => entry.id.toLowerCase() === teamId.trim().toLowerCase()) ?? null
  );
}
