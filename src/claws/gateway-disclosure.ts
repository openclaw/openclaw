import type {
  ClawConfiguredAccess,
  ClawScheduledJobs,
} from "../../packages/gateway-protocol/src/schema/claws.js";
import {
  listAgentEntries,
  listAgentIds,
  resolveAgentConfig,
  toAgentEntriesRecord,
} from "../agents/agent-scope-config.js";
import { resolveMemorySearchIndexConfig } from "../agents/memory-search.js";
import { resolveSandboxConfigForAgent } from "../agents/sandbox/config.js";
import {
  resolveSubagentAllowedTargetIds,
  resolveSubagentTargetPolicy,
} from "../agents/subagents/spawn/subagent-target-policy.js";
import { resolveConfiguredToolAccess } from "../agents/tool-access-diagnostics.js";
import { listCoreToolSections } from "../agents/tool-catalog.js";
import { resolveEffectiveToolFsWorkspaceOnly } from "../agents/tool-fs-policy.js";
import type { AgentConfig } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveHeartbeatConfig } from "../infra/heartbeat-config.js";
import { resolveHeartbeatSummaryForAgent } from "../infra/heartbeat-summary.js";
import { DEFAULT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import { isTrustedSecretSurfaceUnavailableError } from "../secrets/runtime-degraded-state.js";
import { runtimeMemorySecretOwnerId } from "../secrets/runtime-memory-secret-owner.js";
import { preserveOperatorAgentSettings } from "./agent-config-ownership.js";
import { digestClawValue } from "./digest.js";
import { cronJobSchema } from "./schema.js";
import type { ClawAddPlan, ClawCronJob } from "./types.js";
import type { ClawUpdatePlan } from "./update-plan-types.js";

type AccessSnapshot = NonNullable<ClawConfiguredAccess["desired"]>;
type ScheduledDeclaration = NonNullable<ClawScheduledJobs["jobs"][number]["proposed"]>;

function configuredMemorySearch(
  config: OpenClawConfig,
  agentId: string,
): AccessSnapshot["memorySearch"] {
  try {
    const memory = resolveMemorySearchIndexConfig(config, agentId);
    if (!memory) {
      return { state: "disabled" };
    }
    return {
      state: "configured",
      rememberAcrossConversations: memory.rememberAcrossConversations,
      sessionMemory: memory.experimental.sessionMemory,
      indexedSources: memory.sources.toSorted(),
      searchSources: memory.searchSources.toSorted(),
      extraPathCount: memory.extraPaths.length,
    };
  } catch (error) {
    if (
      isTrustedSecretSurfaceUnavailableError(error) &&
      error.ownerKind === "capability" &&
      error.ownerId === runtimeMemorySecretOwnerId(agentId)
    ) {
      return { state: "unresolved" };
    }
    throw error;
  }
}

function configuredSubagentTargets(
  config: OpenClawConfig,
  agentId: string,
): AccessSnapshot["subagentTargets"] {
  const subagents = resolveAgentConfig(config, agentId)?.subagents;
  const defaults = config.agents?.defaults?.subagents;
  const requireAgentId = subagents?.requireAgentId ?? defaults?.requireAgentId ?? false;
  const policy = {
    requesterAgentId: agentId,
    allowAgents: subagents?.allowAgents ?? defaults?.allowAgents,
    configuredAgentIds: listAgentIds(config),
  };
  const targets = resolveSubagentAllowedTargetIds(policy);
  return {
    allowedAgentIds: targets.allowedIds,
    allowAnyConfiguredAgent: targets.allowAny,
    implicitSelfAllowed:
      !requireAgentId && resolveSubagentTargetPolicy({ ...policy, targetAgentId: agentId }).ok,
    requireAgentId,
  };
}

function configuredSnapshot(config: OpenClawConfig, agentId: string): AccessSnapshot {
  const tools = resolveConfiguredToolAccess({
    config,
    agentId,
    toolNames: listCoreToolSections().flatMap((section) => section.tools.map((tool) => tool.id)),
  });
  const sandbox = resolveSandboxConfigForAgent(config, agentId);
  const heartbeat = resolveHeartbeatSummaryForAgent(config, agentId);
  const heartbeatConfig = resolveHeartbeatConfig(config, agentId);
  return {
    tools: {
      allowed: tools.tools
        .filter((tool) => tool.status === "allowed")
        .map((tool) => tool.id)
        .toSorted(),
      excluded: tools.tools
        .filter((tool) => tool.status === "excluded")
        .map((tool) => tool.id)
        .toSorted(),
    },
    sandbox: {
      mode: sandbox.mode,
      scope: sandbox.scope,
      workspaceAccess: sandbox.workspaceAccess,
      backend:
        sandbox.backend === "docker" || sandbox.backend === "ssh" ? sandbox.backend : "other",
    },
    filesystem: { workspaceOnly: resolveEffectiveToolFsWorkspaceOnly({ cfg: config, agentId }) },
    heartbeat: {
      enabled: heartbeat.enabled,
      intervalMs: heartbeat.everyMs,
      ...(heartbeatConfig?.activeHours ? { activeHours: heartbeatConfig.activeHours } : {}),
      ...(heartbeatConfig?.isolatedSession !== undefined
        ? { isolatedSession: heartbeatConfig.isolatedSession }
        : {}),
    },
    memorySearch: configuredMemorySearch(config, agentId),
    subagentTargets: configuredSubagentTargets(config, agentId),
  };
}

export function projectClawConfiguredAccess(params: {
  config: OpenClawConfig;
  agentId: string;
  desiredAgent: AgentConfig;
  operation: "add" | "update";
}): ClawConfiguredAccess {
  const existing = listAgentEntries(params.config);
  const preserved = existing.length ? existing : [{ id: DEFAULT_AGENT_ID, default: true }];
  const index = preserved.findIndex(
    (agent) => normalizeAgentId(agent.id) === normalizeAgentId(params.agentId),
  );
  if (
    (params.operation === "add" && index !== -1) ||
    (params.operation === "update" && index < 0)
  ) {
    throw new Error("Claw configured access cannot be reviewed for this agent state.");
  }
  const desiredEntries = [...preserved];
  if (index === -1) {
    desiredEntries.push(params.desiredAgent);
  } else {
    desiredEntries[index] = preserveOperatorAgentSettings(params.desiredAgent, preserved[index]);
  }
  const desiredConfig: OpenClawConfig = {
    ...params.config,
    agents: {
      ...params.config.agents,
      entries: toAgentEntriesRecord(desiredEntries),
    },
  };
  return {
    coverage: "configuration-only",
    ...(params.operation === "update"
      ? { current: configuredSnapshot(params.config, params.agentId) }
      : {}),
    desired: configuredSnapshot(desiredConfig, params.agentId),
    unresolved: [
      "runtime-tools",
      "sandbox-runtime",
      "memory-runtime",
      "subagent-runtime",
      "scheduler-runtime",
    ],
  };
}

function scheduledDeclaration(job: ClawCronJob): ScheduledDeclaration {
  return {
    schedule: { cron: job.schedule.cron, timezone: job.schedule.timezone },
    session: job.session,
    delivery: job.delivery?.mode === "announce" ? "last-channel" : "none",
  };
}

export function projectClawAddScheduledJobs(plan: ClawAddPlan): ClawScheduledJobs {
  return {
    coverage: "package-declarations",
    jobs: plan.actions
      .filter((action) => action.kind === "cronJob")
      .map((action) => {
        const details = action.details;
        const parsed = cronJobSchema.safeParse({
          id: details?.id,
          name: details?.name,
          schedule: details?.schedule,
          session: details?.session,
          message: details?.message,
          delivery: details?.delivery,
        });
        if (!parsed.success || parsed.data.id !== action.id || action.action !== "schedule") {
          throw new Error("Claw scheduled declaration preview is unavailable.");
        }
        return {
          id: action.id,
          action: action.action,
          blocked: action.blocked,
          proposed: scheduledDeclaration(parsed.data),
        };
      }),
  };
}

export function projectClawUpdateScheduledJobs(
  plan: ClawUpdatePlan,
  currentJobs: readonly ClawCronJob[],
  targetJobs: readonly ClawCronJob[],
): ClawScheduledJobs {
  return {
    coverage: "package-declarations",
    jobs: plan.actions
      .filter((action) => action.kind === "cronJob")
      .map((action) => {
        const currentMatches = currentJobs.filter((job) => job.id === action.id);
        const current = currentMatches[0];
        const matches = targetJobs.filter((job) => job.id === action.id);
        const target = matches[0];
        if (
          currentMatches.length > 1 ||
          matches.length > 1 ||
          (current && action.currentDigest !== digestClawValue(current)) ||
          (!current && action.currentDigest) ||
          (target && action.desiredDigest !== digestClawValue(target)) ||
          (!target && action.desiredDigest)
        ) {
          throw new Error("Claw scheduled declaration preview is unavailable.");
        }
        const projected: ClawScheduledJobs["jobs"][number] = {
          id: action.id,
          action: action.action,
          blocked: action.blocked,
        };
        if (current) {
          projected.current = scheduledDeclaration(current);
        }
        if (target) {
          projected.proposed = scheduledDeclaration(target);
        }
        return projected;
      }),
  };
}
