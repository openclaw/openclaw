/**
 * Resolves subagent thinking-level inheritance and overrides. Spawning uses
 * this helper to patch the child session without leaking invalid caller input.
 */
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeThinkLevel } from "../../../auto-reply/thinking.shared.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";

export function resolveSubagentThinkingOverride(params: {
  cfg: OpenClawConfig;
  requesterAgentConfig?: unknown;
  targetAgentConfig?: unknown;
  thinkingOverrideRaw?: string;
  callerThinkingRaw?: string;
}) {
  const requesterSubagents = asOptionalObjectRecord(
    asOptionalObjectRecord(params.requesterAgentConfig)?.subagents,
  );
  const targetSubagents = asOptionalObjectRecord(
    asOptionalObjectRecord(params.targetAgentConfig)?.subagents,
  );
  const defaultSubagents = asOptionalObjectRecord(params.cfg.agents?.defaults?.subagents);
  const resolvedThinkingDefaultRaw =
    normalizeOptionalString(requesterSubagents?.thinking) ??
    normalizeOptionalString(targetSubagents?.thinking) ??
    normalizeOptionalString(defaultSubagents?.thinking);

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
