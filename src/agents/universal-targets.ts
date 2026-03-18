import type { OpenClawConfig } from "../config/config.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolveAgentConfig } from "./agent-scope.js";

const UNIVERSAL_SUBAGENT_TARGET_IDS = ["scout"] as const;
const UNIVERSAL_SUBAGENT_TARGET_SET = new Set<string>(UNIVERSAL_SUBAGENT_TARGET_IDS);

export function listUniversalSubagentTargets(): string[] {
  return [...UNIVERSAL_SUBAGENT_TARGET_IDS];
}

export function isUniversalSubagentTarget(agentId?: string | null): boolean {
  const trimmed = typeof agentId === "string" ? agentId.trim() : "";
  if (!trimmed) {
    return false;
  }
  return UNIVERSAL_SUBAGENT_TARGET_SET.has(normalizeAgentId(trimmed));
}

export function resolveRequesterSubagentAllowlist(params: {
  cfg: OpenClawConfig;
  requesterAgentId: string;
}): {
  allowAny: boolean;
  explicitAllowSet: Set<string>;
  allowSet: Set<string>;
} {
  const allowAgents =
    resolveAgentConfig(params.cfg, params.requesterAgentId)?.subagents?.allowAgents ?? [];
  const allowAny = allowAgents.some((value) => value.trim() === "*");
  const explicitAllowSet = new Set(
    allowAgents
      .filter((value) => value.trim() && value.trim() !== "*")
      .map((value) => normalizeAgentId(value)),
  );
  const allowSet = new Set(explicitAllowSet);
  for (const agentId of UNIVERSAL_SUBAGENT_TARGET_IDS) {
    allowSet.add(agentId);
  }
  return { allowAny, explicitAllowSet, allowSet };
}
