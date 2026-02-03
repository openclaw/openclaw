/**
 * Fork-specific thinking budget integration.
 *
 * This file isolates OpenClaw fork extensions for budget-aware warnings
 * to minimize merge conflicts with upstream code.
 */

import type { Api, Model } from "@mariozechner/pi-ai";
import type { ThinkLevel } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/config.js";
import { log } from "../agents/pi-embedded-runner/logger.js";
import {
  checkThinkingBudgetConflict,
  resolveThinkingTokenBudget,
} from "../agents/thinking-budgets.js";

/**
 * Emit a warning if the thinking budget would conflict with available context space.
 *
 * This helps prevent context overflow by alerting when:
 * - Thinking budget + compaction reserve + estimated usage > context window
 * - A lower thinking level would be more appropriate
 *
 * @param params - Configuration for budget conflict check
 */
export function warnIfThinkingBudgetConflict(params: {
  provider: string;
  modelId: string;
  model: Model<Api>;
  thinkLevel: ThinkLevel;
  config?: OpenClawConfig;
  compactionReserve: number;
}): void {
  if (!params.thinkLevel || params.thinkLevel === "off") {
    return;
  }

  const thinkingBudget = resolveThinkingTokenBudget(
    params.provider,
    params.modelId,
    params.thinkLevel,
  );

  const contextWindow = params.model.contextWindow;

  // Estimate used tokens (conservative: assume 30% of context used)
  // In practice, this varies based on session history length
  // We use 30% as a reasonable baseline for typical sessions
  const estimatedUsedTokens = Math.floor(contextWindow * 0.3);

  const budgetCheck = checkThinkingBudgetConflict({
    thinkingBudget,
    contextWindow,
    usedTokens: estimatedUsedTokens,
    reserveTokens: params.compactionReserve,
  });

  if (budgetCheck.hasConflict) {
    log.warn(
      `thinking budget conflict: ${params.provider}/${params.modelId} ` +
        `thinking=${params.thinkLevel} ` +
        `budget=${budgetCheck.needed.toLocaleString()} ` +
        `available=${budgetCheck.available.toLocaleString()} ` +
        `window=${contextWindow.toLocaleString()} ` +
        `reserve=${params.compactionReserve.toLocaleString()} ` +
        `→ consider: ${budgetCheck.recommendation}`,
    );
  }
}
