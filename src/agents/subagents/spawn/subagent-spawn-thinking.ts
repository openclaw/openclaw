import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeThinkLevel } from "../../../auto-reply/thinking.shared.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { ResolvedAgentConfig } from "../../agent-scope-config.js";

export function resolveSubagentThinkingOverride(params: {
  cfg: OpenClawConfig;
  requesterAgentConfig?: ResolvedAgentConfig;
  targetAgentConfig?: ResolvedAgentConfig;
  thinkingOverrideRaw?: string;
  callerThinkingRaw?: string;
}) {
  const resolvedThinkingDefaultRaw =
    normalizeOptionalString(params.requesterAgentConfig?.subagents?.thinking) ??
    normalizeOptionalString(params.targetAgentConfig?.subagents?.thinking) ??
    normalizeOptionalString(params.cfg.agents?.defaults?.subagents?.thinking);

  const overrideCandidateRaw = params.thinkingOverrideRaw || resolvedThinkingDefaultRaw;
  const candidate = overrideCandidateRaw || params.callerThinkingRaw;
  const normalizedThinking = candidate ? normalizeThinkLevel(candidate) : undefined;
  if (overrideCandidateRaw && !normalizedThinking) {
    return {
      status: "error" as const,
      thinkingCandidateRaw: overrideCandidateRaw,
    };
  }

  return {
    status: "ok" as const,
    thinkingOverride: overrideCandidateRaw ? normalizedThinking : undefined,
    initialSessionPatch: normalizedThinking ? { thinkingLevel: normalizedThinking } : {},
  };
}
