import { stableStringify } from "@openclaw/normalization-core";
import {
  listAgentEntries,
  listAgentIds,
  resolveAgentEntry,
  resolveAgentWorkspaceDir,
} from "../agents/agent-scope-config.js";
import { readConfigFileSnapshot } from "../config/config.js";
import type { AgentConfig } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { digestClawAgentConfig } from "./agent-config-digest.js";
import type { PersistedClawInstall } from "./provenance.js";
import type { ClawAddPlan } from "./types.js";

export function planAdoptsAgent(plan: ClawAddPlan): boolean {
  return plan.actions.some((action) => action.kind === "agent" && action.action === "adopt");
}

export function canonicalizeClawAgent(agent: AgentConfig, agentId = agent.id): AgentConfig {
  return { ...agent, id: normalizeAgentId(agentId) };
}

export function resolveCanonicalClawAgent(
  config: OpenClawConfig,
  agentId: string,
): AgentConfig | undefined {
  const agent = resolveAgentEntry(config, agentId);
  return agent ? canonicalizeClawAgent(agent, agentId) : undefined;
}

export function resolveClawAgentRosterKey(
  config: OpenClawConfig,
  agentId: string,
): string | undefined {
  return resolveAgentEntry(config, agentId)?.id;
}

function resolveClawPlanningAgentRoster(
  config: OpenClawConfig,
  sourceConfig: OpenClawConfig = config,
) {
  const configuredAgents = listAgentEntries(sourceConfig).map((agent) =>
    Object.assign({}, agent, { id: normalizeAgentId(agent.id) }),
  );
  const configuredAgentsById = new Map(configuredAgents.map((agent) => [agent.id, agent]));
  // Disk owns the config mutation target, while the runtime can still be serving an agent that
  // was removed on disk but has not converged yet. Include both views so a newly written agent is
  // adoptable and a still-live stale agent continues to protect its workspace.
  const sourceAgentIds = listAgentIds(sourceConfig);
  const runtimeAgentIds = listAgentIds(config);
  const agentIds = [...new Set([...sourceAgentIds, ...runtimeAgentIds])];
  const sourceAgentIdSet = new Set(sourceAgentIds);
  const existingAgents = agentIds.map((agentId) =>
    Object.assign({}, configuredAgentsById.get(agentId) ?? { id: agentId }, {
      resolvedWorkspace: resolveAgentWorkspaceDir(
        sourceAgentIdSet.has(agentId) ? sourceConfig : config,
        agentId,
      ),
    }),
  );
  const existingWorkspacePaths = [
    ...sourceAgentIds.map((agentId) => resolveAgentWorkspaceDir(sourceConfig, agentId)),
    ...runtimeAgentIds.map((agentId) => resolveAgentWorkspaceDir(config, agentId)),
  ];
  return { configuredAgents, existingAgents, existingWorkspacePaths };
}

export async function readClawPlanningAgentRoster(config: OpenClawConfig) {
  const snapshot = await readConfigFileSnapshot({ observe: false });
  return resolveClawPlanningAgentRoster(config, snapshot.sourceConfig);
}

export function exactCommittedClawAgentExists(params: {
  config: OpenClawConfig;
  agentId: string;
  expected: AgentConfig[];
}): boolean {
  const agent = resolveCanonicalClawAgent(params.config, params.agentId);
  return Boolean(
    agent &&
    params.expected.some((expected) => stableStringify(agent) === stableStringify(expected)),
  );
}

export async function assertAgentAdoptionDigest(params: {
  plan: ClawAddPlan;
  install: PersistedClawInstall;
  readConfig?: () => OpenClawConfig | Promise<OpenClawConfig>;
}): Promise<void> {
  // The runtime snapshot may predate package preflight. Re-read disk here so mutations cannot
  // begin after an adoption target has changed behind the pinned CLI view.
  const config = await (
    params.readConfig ??
    (async () => (await readConfigFileSnapshot({ observe: false })).sourceConfig)
  )();
  const normalizedAgentId = normalizeAgentId(params.plan.agent.finalId);
  const canonicalAgent = resolveCanonicalClawAgent(config, normalizedAgentId);
  if (
    !canonicalAgent ||
    digestClawAgentConfig(canonicalAgent) !== params.install.agentConfigDigest
  ) {
    throw new Error(`Agent ${JSON.stringify(params.plan.agent.finalId)} changed after planning.`);
  }
}

export function exactExistingAgentIsAuthorized(params: {
  adoption: boolean;
  durableConfigCommitted: boolean;
}): boolean {
  return params.adoption || params.durableConfigCommitted;
}

export function createdAgentMayBeAbsentDuringResume(
  record: Pick<PersistedClawInstall, "agentOrigin" | "status">,
  committedAgentExists: boolean,
): boolean {
  // Adopted entries must remain visible so resume planning can reassert exact ownership.
  return (
    record.agentOrigin === "created" &&
    (record.status === "config_committed" ||
      (record.status === "workspace_ready" && committedAgentExists))
  );
}

export function isExactAdoptedAgentResumeCandidate(params: {
  requested: boolean;
  record: PersistedClawInstall | undefined;
  liveAgent: AgentConfig | undefined;
}): boolean {
  const canonicalAgent =
    params.liveAgent && params.record
      ? canonicalizeClawAgent(params.liveAgent, params.record.agentId)
      : undefined;
  return (
    params.requested &&
    params.record?.agentOrigin === "adopted" &&
    params.record.status !== "complete" &&
    canonicalAgent !== undefined &&
    params.record.workspace === canonicalAgent.workspace &&
    params.record.agentConfigDigest === digestClawAgentConfig(canonicalAgent)
  );
}
