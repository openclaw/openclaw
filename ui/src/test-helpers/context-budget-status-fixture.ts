// Control UI test helper builds runtime-shaped session context budget snapshots.
import { resolveEffectiveCompactionReserveTokens } from "../../../src/agents/agent-compaction-constants.js";
import type { SessionContextBudgetStatus } from "../../../src/config/sessions/types.js";

/** Catalog context window of the fixture session's model. */
export const CATALOG_CONTEXT_TOKENS = 262_144;

/** Budget the runtime enforces for the session; below the catalog window. */
export const SESSION_CONTEXT_TOKEN_BUDGET = 200_000;

/**
 * `DEFAULT_AGENT_COMPACTION_RESERVE_TOKENS_FLOOR` (`src/agents/agent-settings.ts`).
 * Inlined rather than imported: that module pulls the model catalog and
 * provider attribution into the browser test graph.
 *
 * It leaves a 180,000-token prompt budget, which is where compaction starts.
 */
export const COMPACTION_RESERVE_TOKENS = 20_000;

/**
 * Prompt size that is comfortable against both the catalog window (61%) and
 * the enforced budget (80%) while already pressuring the prompt budget (89%).
 */
export const PRESSURED_PROMPT_TOKENS = 160_000;

/**
 * Mirrors `buildPrePromptContextBudgetStatus()` in
 * `src/agents/embedded-agent-runner/run/preemptive-compaction.ts`, so display
 * tests measure against the field relationships the gateway actually publishes:
 * the reserve is capped by `resolveEffectiveCompactionReserveTokens()`, the
 * prompt budget is the budget minus that capped reserve, and overflow, route
 * and remaining budget follow from the estimate rather than being chosen.
 *
 * Covers transcripts with no reducible tool output, the runtime's
 * `toolResultReducibleChars <= 0` branch: it is the one route rule that holds
 * without also reproducing the truncation thresholds.
 */
export function createContextBudgetStatusFixture(params: {
  contextTokenBudget: number;
  reserveTokens: number;
  estimatedPromptTokens: number;
  provider?: string;
  model?: string;
  messageCount?: number;
  updatedAt?: number;
}): SessionContextBudgetStatus {
  const contextTokenBudget = Math.max(1, Math.floor(params.contextTokenBudget));
  const effectiveReserveTokens = resolveEffectiveCompactionReserveTokens({
    contextTokenBudget,
    reserveTokens: params.reserveTokens,
  });
  const promptBudgetBeforeReserve = Math.max(1, contextTokenBudget - effectiveReserveTokens);
  const estimatedPromptTokens = Math.max(0, Math.floor(params.estimatedPromptTokens));
  const overflowTokens = Math.max(0, estimatedPromptTokens - promptBudgetBeforeReserve);
  const messageCount = params.messageCount ?? 12;
  return {
    schemaVersion: 1,
    source: "pre-prompt-estimate",
    updatedAt: params.updatedAt ?? 1_700_000_000_000,
    provider: params.provider ?? "anthropic",
    model: params.model ?? "claude-opus-5",
    route: overflowTokens > 0 ? "compact_only" : "fits",
    shouldCompact: overflowTokens > 0,
    estimatedPromptTokens,
    contextTokenBudget,
    promptBudgetBeforeReserve,
    reserveTokens: Math.max(0, Math.floor(params.reserveTokens)),
    effectiveReserveTokens,
    remainingPromptBudgetTokens: Math.max(0, promptBudgetBeforeReserve - estimatedPromptTokens),
    overflowTokens,
    toolResultReducibleChars: 0,
    messageCount,
    unwindowedMessageCount: messageCount,
  };
}
