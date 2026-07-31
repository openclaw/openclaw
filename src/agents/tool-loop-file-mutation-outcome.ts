import type { ToolCallRecord } from "../logging/diagnostic-session-state.js";
import { isPlainObject } from "../utils.js";
import type { AgentToolResult } from "./runtime/index.js";

const FILE_MUTATION_TOOLS = new Set(["apply_patch", "edit", "write"]);

function isFileMutationTool(toolName: string): boolean {
  return FILE_MUTATION_TOOLS.has(toolName);
}

export function isFileMutationNoProgressOutcome(
  toolName: string,
  details: Record<string, unknown>,
): boolean {
  // Display text includes paths and formatting details; the structured flag is
  // the stable contract shared by built-in file mutation tools.
  return isFileMutationTool(toolName) && details.changed === false;
}

export function buildUntrackedFileMutationNoProgressResult(
  toolName: string,
  result: AgentToolResult<unknown>,
): AgentToolResult<unknown> | undefined {
  if (!isPlainObject(result) || !isPlainObject(result.details)) {
    return undefined;
  }
  if (!isFileMutationNoProgressOutcome(toolName, result.details)) {
    return undefined;
  }
  return {
    ...result,
    terminate: true,
  };
}

export function buildFileMutationNoProgressMessage(toolName: string): string {
  return `CRITICAL: ${toolName} repeated an identical no-op file mutation. Stop retrying unchanged content; inspect or repair the input, choose a different action, or finish without rewriting the file.`;
}

function isImmediateFileMutationNoProgressRetry(
  history: readonly ToolCallRecord[],
  toolName: string,
  argsHash: string,
): boolean {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const record = history[index];
    if (!record || record.outcomeKind === "tool-loop-veto") {
      continue;
    }
    return (
      record.toolName === toolName &&
      record.argsHash === argsHash &&
      record.outcomeKind === "file-mutation-no-progress"
    );
  }
  return false;
}

export function isRepeatedFileMutationNoProgressOutcome(
  history: readonly ToolCallRecord[],
  current: ToolCallRecord,
): boolean {
  if (current.outcomeKind !== "file-mutation-no-progress") {
    return false;
  }
  const currentIndex = history.lastIndexOf(current);
  if (currentIndex <= 0) {
    return false;
  }
  return isImmediateFileMutationNoProgressRetry(
    history.slice(0, currentIndex),
    current.toolName,
    current.argsHash,
  );
}
