import { formatThinkingLevels } from "../../auto-reply/thinking.js";
import { normalizeThinkLevel } from "../../auto-reply/thinking.shared.js";
import { splitModelRef } from "../subagents/spawn/subagent-spawn-plan.js";
import { readToolStringParam, ToolInputError } from "./common.js";

/** Normalizes an explicit visible-session thinking value for Gateway validation. */
export function resolveVisibleSpawnThinkingLevel(
  resolvedModel: string,
  raw: Record<string, unknown>,
): string | undefined {
  const thinkingOverrideRaw = readToolStringParam(raw, "thinking");
  if (!thinkingOverrideRaw) {
    return undefined;
  }
  const thinkingLevel = normalizeThinkLevel(thinkingOverrideRaw);
  if (!thinkingLevel) {
    const { provider, model } = splitModelRef(resolvedModel);
    throw new ToolInputError(
      `Invalid thinking level "${thinkingOverrideRaw}". Use one of: ${formatThinkingLevels(provider, model)}.`,
    );
  }
  return thinkingLevel;
}
