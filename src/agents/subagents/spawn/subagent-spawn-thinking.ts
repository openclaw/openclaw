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
  if (overrideCandidateRaw) {
    const normalizedThinking = normalizeThinkLevel(overrideCandidateRaw);
    if (!normalizedThinking) {
      return {
        status: "error" as const,
        thinkingCandidateRaw: overrideCandidateRaw,
      };
    }

    return {
      status: "ok" as const,
      thinkingOverride: normalizedThinking,
      initialSessionPatch: {
        thinkingLevel: normalizedThinking,
      },
    };
  }

  const normalizedThinking = params.callerThinkingRaw
    ? normalizeThinkLevel(params.callerThinkingRaw)
    : undefined;
  return {
    status: "ok" as const,
    thinkingOverride: undefined,
    initialSessionPatch: normalizedThinking ? { thinkingLevel: normalizedThinking } : {},
  };
}
