import {
  normalizeThinkLevel,
  type ElevatedLevel,
  type ReasoningLevel,
  type ThinkLevel,
  type VerboseLevel,
} from "../thinking.js";

export async function resolveCurrentDirectiveLevels(params: {
  sessionEntry?: {
    thinkingLevel?: unknown;
    verboseLevel?: unknown;
    reasoningLevel?: unknown;
    elevatedLevel?: unknown;
  };
  agentCfg?: {
    thinkingDefault?: unknown;
    verboseDefault?: unknown;
    elevatedDefault?: unknown;
  };
  resolveDefaultThinkingLevel: () => Promise<ThinkLevel | undefined>;
}): Promise<{
  currentThinkLevel: ThinkLevel | undefined;
  currentVerboseLevel: VerboseLevel | undefined;
  currentReasoningLevel: ReasoningLevel;
  currentElevatedLevel: ElevatedLevel | undefined;
}> {
  const resolvedDefaultThinkLevel =
    normalizeThinkLevel(
      typeof params.sessionEntry?.thinkingLevel === "string"
        ? params.sessionEntry.thinkingLevel
        : undefined,
    ) ??
    (params.agentCfg?.thinkingDefault as ThinkLevel | undefined) ??
    (await params.resolveDefaultThinkingLevel());
  const currentThinkLevel = resolvedDefaultThinkLevel;
  const currentVerboseLevel =
    (params.sessionEntry?.verboseLevel as VerboseLevel | undefined) ??
    (params.agentCfg?.verboseDefault as VerboseLevel | undefined);
  const currentReasoningLevel =
    (params.sessionEntry?.reasoningLevel as ReasoningLevel | undefined) ?? "off";
  const currentElevatedLevel =
    (params.sessionEntry?.elevatedLevel as ElevatedLevel | undefined) ??
    (params.agentCfg?.elevatedDefault as ElevatedLevel | undefined);
  return {
    currentThinkLevel,
    currentVerboseLevel,
    currentReasoningLevel,
    currentElevatedLevel,
  };
}
