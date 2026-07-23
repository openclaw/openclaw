// UI-relevant equality for SessionInfo: decides whether a session-info refresh
// actually changes what the TUI renders (footer, model line, token counts).
import type { SessionInfo } from "./tui-types.js";

function thinkingLevelsEqual(
  left?: Array<{ id: string; label: string }>,
  right?: Array<{ id: string; label: string }>,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right || left.length !== right.length) {
    return false;
  }
  return left.every((level, index) => {
    const other = right[index];
    return other?.id === level.id && other.label === level.label;
  });
}

function goalEquals(left: SessionInfo["goal"], right: SessionInfo["goal"]): boolean {
  return left === right || JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function agentRuntimeEquals(
  left: SessionInfo["agentRuntime"],
  right: SessionInfo["agentRuntime"],
): boolean {
  return (
    left === right ||
    (left?.id === right?.id && left?.source === right?.source && left?.fallback === right?.fallback)
  );
}

export function sessionInfoUiEquals(left: SessionInfo, right: SessionInfo): boolean {
  return (
    left.thinkingLevel === right.thinkingLevel &&
    thinkingLevelsEqual(left.thinkingLevels, right.thinkingLevels) &&
    left.fastMode === right.fastMode &&
    left.verboseLevel === right.verboseLevel &&
    left.traceLevel === right.traceLevel &&
    left.reasoningLevel === right.reasoningLevel &&
    left.model === right.model &&
    left.modelProvider === right.modelProvider &&
    agentRuntimeEquals(left.agentRuntime, right.agentRuntime) &&
    left.contextTokens === right.contextTokens &&
    left.inputTokens === right.inputTokens &&
    left.outputTokens === right.outputTokens &&
    left.totalTokens === right.totalTokens &&
    left.responseUsage === right.responseUsage &&
    left.effectiveResponseUsage === right.effectiveResponseUsage &&
    left.displayName === right.displayName &&
    goalEquals(left.goal, right.goal)
  );
}
