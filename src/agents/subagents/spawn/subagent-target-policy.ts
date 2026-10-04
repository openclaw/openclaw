/**
 * Subagent spawn target policy. Requesters can self-spawn by default, or opt
 * into a configured allowlist that is still intersected with known agents.
 */
import {
  normalizeUniqueStringEntries,
  sortUniqueStrings,
} from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { isValidAgentId, normalizeAgentId } from "../../../routing/session-key.js";
import { summarizeStringEntries } from "../../../shared/string-sample.js";
import { resolveAgentConfig } from "../../agent-scope-config.js";

// Normalized agent ids are at most 64 chars, so this count also bounds the listed bytes.
const MAX_LISTED_TARGET_IDS = 20;

type SubagentTargetPolicyResult = { ok: true } | { ok: false; allowedText: string; error: string };

function normalizeAllowAgents(allowAgents: readonly string[] | undefined): Set<string> | undefined {
  if (!Array.isArray(allowAgents)) {
    return undefined;
  }
  return new Set(
    allowAgents
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => (value === "*" ? value : normalizeAgentId(value)))
      .filter(Boolean),
  );
}

function normalizeConfiguredAgentIds(
  configuredAgentIds: readonly string[] | undefined,
): Set<string> {
  return new Set(normalizeUniqueStringEntries((configuredAgentIds ?? []).map(normalizeAgentId)));
}

/** Resolve the normalized agent IDs a requester may target with sessions_spawn. */
export function resolveSubagentAllowedTargetIds(params: {
  requesterAgentId: string;
  allowAgents?: readonly string[];
  configuredAgentIds?: readonly string[];
}): { allowAny: boolean; allowedIds: string[]; explicitAllowlistConfigured: boolean } {
  const requesterAgentId = normalizeAgentId(params.requesterAgentId);
  const policy = normalizeAllowAgents(params.allowAgents);
  if (!policy) {
    return {
      allowAny: false,
      allowedIds: requesterAgentId ? [requesterAgentId] : [],
      explicitAllowlistConfigured: false,
    };
  }
  if (policy.has("*")) {
    const configuredIds = Array.from(normalizeConfiguredAgentIds(params.configuredAgentIds));
    if (requesterAgentId) {
      configuredIds.push(requesterAgentId);
    }
    return {
      allowAny: true,
      allowedIds: sortUniqueStrings(configuredIds),
      explicitAllowlistConfigured: true,
    };
  }
  const configuredIds = normalizeConfiguredAgentIds(params.configuredAgentIds);
  return {
    allowAny: false,
    allowedIds: [...policy]
      .filter((id) => configuredIds.has(id))
      .toSorted((a, b) => a.localeCompare(b)),
    explicitAllowlistConfigured: true,
  };
}

/** Resolve a requester's effective spawn target settings: agent override, then defaults. */
export function resolveSubagentSpawnTargetConfig(
  cfg: OpenClawConfig,
  requesterAgentId: string,
): { allowAgents: string[] | undefined; requireAgentId: boolean } {
  const subagents = resolveAgentConfig(cfg, requesterAgentId)?.subagents;
  const defaults = cfg.agents?.defaults?.subagents;
  return {
    allowAgents: subagents?.allowAgents ?? defaults?.allowAgents,
    requireAgentId: subagents?.requireAgentId ?? defaults?.requireAgentId ?? false,
  };
}

/** Render `label: ids.` for model-facing guidance, capped to the first sorted ids. */
export function describeTargetIdList(label: string, ids: readonly string[]): string {
  const list = summarizeStringEntries({ entries: ids, limit: MAX_LISTED_TARGET_IDS });
  const overflow =
    ids.length > MAX_LISTED_TARGET_IDS
      ? ` Only the first ${MAX_LISTED_TARGET_IDS} ids are listed.`
      : "";
  return `${label}: ${list}.${overflow}`;
}

/** Describe the sessions_spawn `agentId` parameter's allowed targets for a requester. */
export function describeSubagentSpawnTargetParameter(params: {
  requesterAgentId: string;
  allowAgents?: readonly string[];
  configuredAgentIds?: readonly string[];
  requireAgentId?: boolean;
  /** `tools.swarm.defaultAgentId`, used when collect=true omits agentId. */
  collectDefaultAgentId?: string;
}): string {
  const requesterAgentId = normalizeAgentId(params.requesterAgentId);
  const allowed = resolveSubagentAllowedTargetIds(params);
  const omitClause = params.requireAgentId
    ? `agentId is required; the requester agent is "${requesterAgentId}".`
    : `Omit to keep the requester agent ("${requesterAgentId}").`;
  const collectId = params.collectDefaultAgentId;
  const collectClause = !collectId
    ? ""
    : isValidAgentId(collectId) && allowed.allowedIds.includes(normalizeAgentId(collectId))
      ? ` With collect=true, omit to target tools.swarm.defaultAgentId ("${collectId}").`
      : ` With collect=true, agentId is required; tools.swarm.defaultAgentId ("${collectId}") is not an allowed target.`;
  if (allowed.allowAny) {
    return `Configured agent to target; any configured agent is allowed. ${omitClause}${collectClause}`;
  }
  if (allowed.allowedIds.length === 0 && allowed.explicitAllowlistConfigured) {
    return `No agentId is allowed as an explicit target; the configured allowlist is empty. ${omitClause}${collectClause}`;
  }
  if (allowed.allowedIds.filter((id) => id !== requesterAgentId).length === 0) {
    return `Only the requester agent is allowed as a target; no other agentId is configured. ${omitClause}${collectClause}`;
  }
  return `${describeTargetIdList("Configured agent to target", allowed.allowedIds)} ${omitClause}${collectClause}`;
}

/** Check a spawn target against the requester's `requireAgentId` and `allowAgents`. */
export function resolveRequesterSpawnTargetPolicy(params: {
  cfg: OpenClawConfig;
  requesterAgentId: string;
  targetAgentId: string;
  requestedAgentId?: string;
  configuredAgentIds: string[];
}): { ok: true } | { ok: false; error: string } {
  const { allowAgents, requireAgentId } = resolveSubagentSpawnTargetConfig(
    params.cfg,
    params.requesterAgentId,
  );
  if (requireAgentId && !params.requestedAgentId?.trim()) {
    return {
      ok: false,
      error:
        "sessions_spawn requires explicit agentId when requireAgentId is configured. Provide an allowed configured agentId.",
    };
  }
  const policy = resolveSubagentTargetPolicy({ ...params, allowAgents });
  return policy.ok ? policy : { ok: false, error: policy.error };
}

/** Validate one requested target against subagent spawn policy. */
function resolveSubagentTargetPolicy(params: {
  requesterAgentId: string;
  targetAgentId: string;
  requestedAgentId?: string;
  allowAgents?: readonly string[];
  configuredAgentIds?: readonly string[];
}): SubagentTargetPolicyResult {
  const requesterAgentId = normalizeAgentId(params.requesterAgentId);
  const targetAgentId = normalizeAgentId(params.targetAgentId);
  if (!params.requestedAgentId?.trim() && targetAgentId === requesterAgentId) {
    return { ok: true };
  }

  const allowed = resolveSubagentAllowedTargetIds({
    requesterAgentId,
    allowAgents: params.allowAgents,
    configuredAgentIds: params.configuredAgentIds,
  });
  if (allowed.allowedIds.includes(targetAgentId)) {
    return { ok: true };
  }
  const allowedText = allowed.allowedIds.length > 0 ? allowed.allowedIds.join(", ") : "none";
  const policy = normalizeAllowAgents(params.allowAgents);
  if (allowed.allowAny || policy?.has(targetAgentId)) {
    return {
      ok: false,
      allowedText,
      error: `agentId "${targetAgentId}" is not in the configured agent registry (allowed: ${allowedText})`,
    };
  }
  return {
    ok: false,
    allowedText,
    error: `agentId is not allowed for sessions_spawn (allowed: ${allowedText})`,
  };
}
