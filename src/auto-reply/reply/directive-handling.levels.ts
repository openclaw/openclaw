// Parses directive level values for reasoning, verbosity, and elevated mode.
import type { ElevatedLevel, ReasoningLevel, ThinkLevel, VerboseLevel } from "../thinking.js";
<<<<<<< HEAD
import { normalizeFastMode, type FastMode } from "../thinking.js";
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

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
<<<<<<< HEAD
  currentFastMode: FastMode | undefined;
=======
  currentFastMode: boolean | undefined;
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  currentVerboseLevel: VerboseLevel | undefined;
  currentReasoningLevel: ReasoningLevel;
  currentElevatedLevel: ElevatedLevel | undefined;
}> {
  const resolvedDefaultThinkLevel =
    (params.sessionEntry?.thinkingLevel as ThinkLevel | undefined) ??
    (await params.resolveDefaultThinkingLevel()) ??
    (params.agentCfg?.thinkingDefault as ThinkLevel | undefined);
  const currentThinkLevel = resolvedDefaultThinkLevel;
  const currentFastMode =
<<<<<<< HEAD
    normalizeFastMode(params.sessionEntry?.fastMode) ??
    normalizeFastMode(params.agentEntry?.fastModeDefault);
=======
    typeof params.sessionEntry?.fastMode === "boolean"
      ? params.sessionEntry.fastMode
      : typeof params.agentEntry?.fastModeDefault === "boolean"
        ? params.agentEntry.fastModeDefault
        : undefined;
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  const currentVerboseLevel =
    (params.sessionEntry?.verboseLevel as VerboseLevel | undefined) ??
    (params.agentCfg?.verboseDefault as VerboseLevel | undefined);
  const currentReasoningLevel =
    (params.sessionEntry?.reasoningLevel as ReasoningLevel | undefined) ??
    (params.agentEntry?.reasoningDefault as ReasoningLevel | undefined) ??
    (params.agentCfg?.reasoningDefault as ReasoningLevel | undefined) ??
    "off";
  const currentElevatedLevel =
    (params.sessionEntry?.elevatedLevel as ElevatedLevel | undefined) ??
    (params.agentCfg?.elevatedDefault as ElevatedLevel | undefined);
  return {
    currentThinkLevel,
    currentFastMode,
    currentVerboseLevel,
    currentReasoningLevel,
    currentElevatedLevel,
  };
}
