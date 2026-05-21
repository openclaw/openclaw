import type { SessionContextBudgetStatus } from "./types.js";

export type SessionContextBudgetPressure = "safe" | "watch" | "pressure" | "overflow-risk";

export type SessionContextBudgetPolicy = {
  pressure: SessionContextBudgetPressure;
  estimatedPromptTokens: number;
  contextBudgetPct?: number;
  promptBudgetPct?: number;
  remainingPromptBudgetTokens: number;
  overflowTokens: number;
  route: SessionContextBudgetStatus["route"];
};

const WATCH_PROMPT_BUDGET_PCT = 65;
const PRESSURE_PROMPT_BUDGET_PCT = 85;

function resolveNonNegativeInteger(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

function resolvePositiveInteger(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function pct(numerator: number, denominator: number | undefined): number | undefined {
  if (denominator === undefined) {
    return undefined;
  }
  return Math.min(999, Math.max(0, Math.round((numerator / denominator) * 100)));
}

export function resolveSessionContextBudgetPolicy(
  status: SessionContextBudgetStatus | undefined,
): SessionContextBudgetPolicy | undefined {
  if (!status || status.source !== "pre-prompt-estimate") {
    return undefined;
  }
  const estimatedPromptTokens = resolveNonNegativeInteger(status.estimatedPromptTokens);
  if (estimatedPromptTokens === undefined) {
    return undefined;
  }
  const contextTokenBudget = resolvePositiveInteger(status.contextTokenBudget);
  const promptBudgetBeforeReserve = resolvePositiveInteger(status.promptBudgetBeforeReserve);
  const overflowTokens = resolveNonNegativeInteger(status.overflowTokens) ?? 0;
  const remainingPromptBudgetTokens =
    resolveNonNegativeInteger(status.remainingPromptBudgetTokens) ??
    Math.max(0, (promptBudgetBeforeReserve ?? 0) - estimatedPromptTokens);
  const promptBudgetPct = pct(estimatedPromptTokens, promptBudgetBeforeReserve);
  const contextBudgetPct = pct(estimatedPromptTokens, contextTokenBudget);
  const pressure: SessionContextBudgetPressure =
    overflowTokens > 0 || status.route !== "fits"
      ? "overflow-risk"
      : promptBudgetPct !== undefined && promptBudgetPct >= PRESSURE_PROMPT_BUDGET_PCT
        ? "pressure"
        : promptBudgetPct !== undefined && promptBudgetPct >= WATCH_PROMPT_BUDGET_PCT
          ? "watch"
          : "safe";
  return {
    pressure,
    estimatedPromptTokens,
    ...(contextBudgetPct !== undefined ? { contextBudgetPct } : {}),
    ...(promptBudgetPct !== undefined ? { promptBudgetPct } : {}),
    remainingPromptBudgetTokens,
    overflowTokens,
    route: status.route,
  };
}
