import { formatThinkingLevels } from "../../auto-reply/thinking.js";
import { normalizeThinkLevel } from "../../auto-reply/thinking.shared.js";
import { splitModelRef } from "../subagents/spawn/subagent-spawn-plan.js";
import { ToolInputError } from "./common.js";

/** Normalizes an explicit visible-session thinking value for Gateway validation. */
export function resolveVisibleSpawnThinkingLevel(params: {
  resolvedModel: string;
  thinkingOverrideRaw?: string;
}): string | undefined {
  if (!params.thinkingOverrideRaw) {
    return undefined;
  }
  const thinkingLevel = normalizeThinkLevel(params.thinkingOverrideRaw);
  if (!thinkingLevel) {
    const { provider, model } = splitModelRef(params.resolvedModel);
    throw new ToolInputError(
      `Invalid thinking level "${params.thinkingOverrideRaw}". Use one of: ${formatThinkingLevels(provider, model)}.`,
    );
  }
  return thinkingLevel;
}
