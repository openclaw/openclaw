/**
 * Subagent spawn target policy. Requesters can self-spawn by default, or opt
 * into a configured allowlist that is still intersected with known agents.
 */
import { normalizeAgentId } from "../../../routing/session-key.js";

type SubagentTargetPolicyResult = { ok: true } | { ok: false; allowedText: string; error: string };

function normalizeAllowAgents(allowAgents: readonly string[] | undefined): Set<string> | undefined {
  if (!Array.isArray(allowAgents)) {
    return undefined;
  }
  return new Set(
    allowAgents
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => (value === "*" ? value : normalizeAgentId(value))),
  );
}

/** Resolve the normalized agent IDs a requester may target with sessions_spawn. */
export function resolveSubagentAllowedTargetIds(params: {
  requesterAgentId: string;
  allowAgents?: readonly string[];
  configuredAgentIds?: readonly string[];
}): { allowAny: boolean; allowedIds: string[] } {
  const requesterAgentId = normalizeAgentId(params.requesterAgentId);
  const policy = normalizeAllowAgents(params.allowAgents);
  if (!policy) {
    return {
      allowAny: false,
      allowedIds: [requesterAgentId],
    };
  }
  const configuredIds = new Set((params.configuredAgentIds ?? []).map(normalizeAgentId));
  if (policy.has("*")) {
    configuredIds.add(requesterAgentId);
    return {
      allowAny: true,
      allowedIds: [...configuredIds].toSorted(),
    };
  }
  return {
    allowAny: false,
    allowedIds: [...policy]
      .filter((id) => configuredIds.has(id))
      .toSorted((a, b) => a.localeCompare(b)),
  };
}

/** Validate one requested target against subagent spawn policy. */
export function resolveSubagentTargetPolicy(params: {
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
  return {
    ok: false,
    allowedText,
    error:
      allowed.allowAny || policy?.has(targetAgentId)
        ? `agentId "${targetAgentId}" is not in the configured agent registry (allowed: ${allowedText})`
        : `agentId is not allowed for sessions_spawn (allowed: ${allowedText})`,
  };
}
