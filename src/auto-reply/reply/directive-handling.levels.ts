import {
  normalizeFastMode,
  type ElevatedLevel,
  type FastMode,
  type ReasoningLevel,
  type ThinkLevel,
  type VerboseLevel,
} from "../thinking.js";

/** Resolves current directive levels from session, agent, and config defaults. */
export async function resolveCurrentDirectiveLevels(params: {
  sessionEntry?: {
    thinkingLevel?: unknown;
    fastMode?: unknown;
    verboseLevel?: unknown;
    reasoningLevel?: unknown;
    elevatedLevel?: unknown;
  };
  agentEntry?: {
    fastModeDefault?: unknown;
    reasoningDefault?: unknown;
  };
  agentCfg?: {
    thinkingDefault?: unknown;
    verboseDefault?: unknown;
    reasoningDefault?: unknown;
    elevatedDefault?: unknown;
  };
  resolveDefaultThinkingLevel: () => Promise<ThinkLevel | undefined>;
}): Promise<{
  currentThinkLevel: ThinkLevel | undefined;
  currentFastMode: FastMode | undefined;
  currentVerboseLevel: VerboseLevel | undefined;
  currentReasoningLevel: ReasoningLevel;
  currentElevatedLevel: ElevatedLevel | undefined;
}> {
  return {
    currentThinkLevel:
      (params.sessionEntry?.thinkingLevel as ThinkLevel | undefined) ??
      (await params.resolveDefaultThinkingLevel()) ??
      (params.agentCfg?.thinkingDefault as ThinkLevel | undefined),
    currentFastMode:
      normalizeFastMode(params.sessionEntry?.fastMode) ??
      normalizeFastMode(params.agentEntry?.fastModeDefault),
    currentVerboseLevel:
      (params.sessionEntry?.verboseLevel as VerboseLevel | undefined) ??
      (params.agentCfg?.verboseDefault as VerboseLevel | undefined),
    currentReasoningLevel:
      (params.sessionEntry?.reasoningLevel as ReasoningLevel | undefined) ??
      (params.agentEntry?.reasoningDefault as ReasoningLevel | undefined) ??
      (params.agentCfg?.reasoningDefault as ReasoningLevel | undefined) ??
      "off",
    currentElevatedLevel:
      (params.sessionEntry?.elevatedLevel as ElevatedLevel | undefined) ??
      (params.agentCfg?.elevatedDefault as ElevatedLevel | undefined),
  };
}
