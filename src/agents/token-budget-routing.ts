/**
 * Token Budget Routing — Model Fallback Integration
 *
 * Wraps the standard `runWithModelFallback` to route requests through
 * budget-tiered models before falling back to the primary model.
 *
 * Flow:
 * 1. Load today's budget state (auto-resets on new day).
 * 2. Find the first non-exhausted budget tier.
 * 3. Call `runWithModelFallback` with the active tier's model, keeping
 *    subsequent tiers + the original primary as fallbacks.
 * 4. After a successful call, record usage against the tier and persist.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { runWithModelFallback } from "./model-fallback.js";
import {
  isBudgetExhausted,
  loadBudgetState,
  recordBudgetUsage,
  resolveActiveTier,
  saveBudgetState,
  tierKey,
} from "./token-budget.js";
import type { TokenBudgetConfig, TokenBudgetState } from "./token-budget.types.js";

const log = createSubsystemLogger("token-budget");

/** Extract the params type from `runWithModelFallback`. */
type ModelFallbackParams<T> = Parameters<typeof runWithModelFallback<T>>[0];

/** Extract the result type from `runWithModelFallback`. */
type ModelFallbackResult<T> = Awaited<ReturnType<typeof runWithModelFallback<T>>>;

/** Parameters for the budget-aware routing wrapper. */
export type TokenBudgetRoutingParams<T> = ModelFallbackParams<T>;

/**
 * Build the fallbacks list for when a budget tier is active.
 *
 * Only non-exhausted remaining budget tiers are included, followed by
 * the original primary model as the final catch-all.
 */
function buildBudgetFallbacks(
  config: TokenBudgetConfig,
  state: TokenBudgetState,
  activeTierIndex: number,
  originalPrimary: { provider: string; model: string },
  originalFallbacks?: string[],
): string[] {
  const fallbacks: string[] = [];

  // Add remaining budget tiers after the active one, skipping exhausted ones.
  for (let i = activeTierIndex + 1; i < config.tiers.length; i++) {
    const tier = config.tiers[i];
    if (!isBudgetExhausted(state, tier)) {
      fallbacks.push(`${tier.provider}/${tier.model}`);
    }
  }

  // Add the original primary model.
  fallbacks.push(`${originalPrimary.provider}/${originalPrimary.model}`);

  // Add original fallbacks if any.
  if (originalFallbacks) {
    for (const fb of originalFallbacks) {
      if (!fallbacks.includes(fb)) {
        fallbacks.push(fb);
      }
    }
  }

  return fallbacks;
}

/** Default token estimate when actual usage is not reported. */
const DEFAULT_ESTIMATED_TOKENS = 4_000;

/**
 * Minimal shape of the usage object embedded in run results.
 * Avoids importing the full `EmbeddedPiRunResult` type (which would
 * pull in a large dependency tree) while still allowing safe extraction.
 */
interface ResultUsageShape {
  meta?: {
    agentMeta?: {
      usage?: {
        input?: number;
        output?: number;
      };
    };
  };
}

/** Attempt to extract input/output token counts from an opaque run result. */
function extractUsageFromResult(result: unknown): { input: number; output: number } | undefined {
  const shaped = result as ResultUsageShape | undefined;
  const usage = shaped?.meta?.agentMeta?.usage;
  if (usage && typeof usage.input === "number" && typeof usage.output === "number") {
    return { input: usage.input, output: usage.output };
  }
  return undefined;
}

/**
 * Budget-aware model routing wrapper.
 *
 * When `tokenBudget` is configured and enabled, this resolves the
 * active budget tier and adjusts the model selection accordingly.
 * Otherwise it delegates directly to `runWithModelFallback`.
 */
export async function runWithTokenBudgetRouting<T>(
  params: TokenBudgetRoutingParams<T>,
): Promise<ModelFallbackResult<T>> {
  const budgetConfig = params.cfg?.tokenBudget;

  // Fast path: no budget config or disabled.
  if (!budgetConfig?.enabled || !budgetConfig.tiers.length) {
    return runWithModelFallback(params);
  }

  // Load and auto-reset budget state.
  const state = loadBudgetState(budgetConfig.resetTime);
  const activeTier = resolveActiveTier(budgetConfig, state);

  // All budget tiers exhausted — use original primary.
  if (!activeTier) {
    log.info(
      `All budget tiers exhausted; falling back to primary ${params.provider}/${params.model}`,
    );
    return runWithModelFallback(params);
  }

  // Find the active tier's index for building fallbacks.
  const activeTierIndex = budgetConfig.tiers.indexOf(activeTier);
  const budgetFallbacks = buildBudgetFallbacks(
    budgetConfig,
    state,
    activeTierIndex,
    { provider: params.provider, model: params.model },
    params.fallbacksOverride,
  );

  log.info(`Routing to budget tier ${activeTier.provider}/${activeTier.model}`);

  // Route through the budget tier.
  const fallbackResult = await runWithModelFallback<T>({
    ...params,
    provider: activeTier.provider,
    model: activeTier.model,
    fallbacksOverride: budgetFallbacks,
  });

  // Record usage if a budget tier model was actually used.
  const usedKey = tierKey(fallbackResult.provider, fallbackResult.model);
  const matchedTier = budgetConfig.tiers.find((t) => tierKey(t.provider, t.model) === usedKey);

  if (matchedTier) {
    // Extract actual usage from the result, or fall back to a conservative estimate.
    const usage = extractUsageFromResult(fallbackResult.result);
    let tokens: number;
    if (usage) {
      tokens = (usage.input || 0) + (usage.output || 0);
    } else {
      tokens = DEFAULT_ESTIMATED_TOKENS;
      log.warn(
        `No usage metadata in result; recording estimate of ${DEFAULT_ESTIMATED_TOKENS} tokens`,
      );
    }

    recordBudgetUsage(state, matchedTier.provider, matchedTier.model, tokens);

    const tierUsage = state.usage.tiers[usedKey] ?? 0;
    const limit = matchedTier.dailyTokenLimit;
    log.info(
      `Budget ${usedKey}: ${tierUsage.toLocaleString()}/${limit.toLocaleString()} tokens used today`,
    );
    if (tierUsage >= limit) {
      log.info(`Budget tier ${usedKey} exhausted — next request will use next tier or primary`);
    }

    try {
      saveBudgetState(state);
    } catch (err) {
      log.warn(`Failed to persist budget state: ${String(err)}`);
    }
  }

  return fallbackResult;
}
