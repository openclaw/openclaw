import type { ThinkLevel } from "../thinking.js";

const MAX_SIMPLE_CHARS = 140;
const MAX_SIMPLE_WORDS = 20;

function countWords(input: string): number {
  return input.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Heuristic: identify short, low-complexity user turns where low thinking effort
 * is typically sufficient.
 */
export function isSimpleTaskTurn(rawBody: string): boolean {
  const body = rawBody.trim();
  if (!body) {
    return false;
  }

  if (body.length > MAX_SIMPLE_CHARS) {
    return false;
  }
  if (countWords(body) > MAX_SIMPLE_WORDS) {
    return false;
  }

  // Multi-line prompts usually indicate richer context or instructions.
  if (body.includes("\n")) {
    return false;
  }

  // Code/structured hints likely need more deliberate reasoning.
  if (
    body.includes("```") ||
    body.includes("{") ||
    body.includes("}") ||
    body.includes("=>") ||
    body.includes("$(") ||
    /https?:\/\//i.test(body)
  ) {
    return false;
  }

  return true;
}

/**
 * Use low thinking for simple turns when the resolved level is adaptive.
 *
 * This is a hinting optimization only:
 * - never overrides explicit `/think` directives
 * - never changes provider/model
 */
export function maybeHintLowThinkingForSimpleTurn(params: {
  resolvedThinkLevel: ThinkLevel;
  hasExplicitThinkDirective: boolean;
  baseBodyTrimmedRaw: string;
}): ThinkLevel {
  if (params.hasExplicitThinkDirective) {
    return params.resolvedThinkLevel;
  }
  if (params.resolvedThinkLevel !== "adaptive") {
    return params.resolvedThinkLevel;
  }
  return isSimpleTaskTurn(params.baseBodyTrimmedRaw) ? "low" : params.resolvedThinkLevel;
}
