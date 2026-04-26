import { type EmotionMode, normalizeEmotionMode } from "../../emotion-mode.js";
import type { ElevatedLevel, ReasoningLevel, ThinkLevel, VerboseLevel } from "../thinking.js";

export async function resolveCurrentDirectiveLevels(params: {
  sessionEntry?: {
    thinkingLevel?: unknown;
    fastMode?: unknown;
    verboseLevel?: unknown;
    emotionMode?: unknown;
    reasoningLevel?: unknown;
    elevatedLevel?: unknown;
  };
  agentEntry?: {
    fastModeDefault?: unknown;
    reasoningDefault?: unknown;
  };
  // PR-B note: agent-level / global `emotionDefault` was dropped per Copilot
  // review (it rejected "full" while session mode accepts it). The
  // globalAgentDefaults parameter is kept for callsite compatibility but no
  // longer carries an emotion-default field.
  globalAgentDefaults?: Record<string, unknown>;
  agentCfg?: {
    thinkingDefault?: unknown;
    verboseDefault?: unknown;
    elevatedDefault?: unknown;
  };
  resolveDefaultThinkingLevel: () => Promise<ThinkLevel | undefined>;
}): Promise<{
  currentThinkLevel: ThinkLevel | undefined;
  currentFastMode: boolean | undefined;
  currentVerboseLevel: VerboseLevel | undefined;
  currentEmotionMode: EmotionMode;
  currentReasoningLevel: ReasoningLevel;
  currentElevatedLevel: ElevatedLevel | undefined;
}> {
  const resolvedDefaultThinkLevel =
    (params.sessionEntry?.thinkingLevel as ThinkLevel | undefined) ??
    (await params.resolveDefaultThinkingLevel()) ??
    (params.agentCfg?.thinkingDefault as ThinkLevel | undefined);
  const currentThinkLevel = resolvedDefaultThinkLevel;
  const currentFastMode =
    typeof params.sessionEntry?.fastMode === "boolean"
      ? params.sessionEntry.fastMode
      : typeof params.agentEntry?.fastModeDefault === "boolean"
        ? params.agentEntry.fastModeDefault
        : undefined;
  const currentVerboseLevel =
    (params.sessionEntry?.verboseLevel as VerboseLevel | undefined) ??
    (params.agentCfg?.verboseDefault as VerboseLevel | undefined);
  // Per Copilot review on directive-handling.levels.ts:51 — validate via
  // `normalizeEmotionMode` before consuming. The session store may carry
  // legacy / manually-edited / future-version values; an unguarded cast would
  // surface them through `/emotions` status output.
  const currentEmotionMode = normalizeEmotionMode(params.sessionEntry?.emotionMode) ?? "off";
  const currentReasoningLevel =
    (params.sessionEntry?.reasoningLevel as ReasoningLevel | undefined) ??
    (params.agentEntry?.reasoningDefault as ReasoningLevel | undefined) ??
    "off";
  const currentElevatedLevel =
    (params.sessionEntry?.elevatedLevel as ElevatedLevel | undefined) ??
    (params.agentCfg?.elevatedDefault as ElevatedLevel | undefined);
  return {
    currentThinkLevel,
    currentFastMode,
    currentVerboseLevel,
    currentEmotionMode,
    currentReasoningLevel,
    currentElevatedLevel,
  };
}
