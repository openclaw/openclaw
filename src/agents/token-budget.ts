/**
 * Token Budget Routing — Core Budget Tracking
 *
 * Manages daily token budget state: loading, saving, day rollover,
 * exhaustion checks, and usage recording.
 */

import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";
import type {
  TokenBudgetConfig,
  TokenBudgetDayUsage,
  TokenBudgetState,
  TokenBudgetTier,
} from "./token-budget.types.js";

const STATE_FILENAME = "token-budget.json";
const CURRENT_VERSION = 1 as const;

/**
 * Build a tier key for use in the usage map.
 * Lowercases both provider and model to match the normalized IDs
 * returned by `runWithModelFallback`.
 */
export function tierKey(provider: string, model: string): string {
  return `${provider.toLowerCase()}/${model.toLowerCase()}`;
}

/**
 * Returns today's date string in "YYYY-MM-DD" format.
 * Uses local timezone by default, or UTC when configured.
 */
export function resolveBudgetDate(resetTime?: TokenBudgetConfig["resetTime"]): string {
  const now = new Date();
  if (resetTime === "midnight-utc") {
    return now.toISOString().slice(0, 10);
  }
  // Local timezone: use en-CA locale which produces "YYYY-MM-DD".
  return now.toLocaleDateString("en-CA", {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
}

function emptyDayUsage(date: string): TokenBudgetDayUsage {
  return { date, tiers: {} };
}

function emptyState(date: string): TokenBudgetState {
  return { version: CURRENT_VERSION, usage: emptyDayUsage(date) };
}

function resolveStatePath(stateDir?: string): string {
  const dir = stateDir ?? path.join(resolveStateDir(), "agents");
  return path.join(dir, STATE_FILENAME);
}

/**
 * Load the persisted budget state from disk.
 * Returns a fresh state for today when the file is missing, malformed,
 * or belongs to a different day (automatic daily reset).
 */
export function loadBudgetState(
  resetTime?: TokenBudgetConfig["resetTime"],
  stateDir?: string,
): TokenBudgetState {
  const today = resolveBudgetDate(resetTime);
  const filePath = resolveStatePath(stateDir);
  const raw = loadJsonFile(filePath);

  if (!raw || typeof raw !== "object") {
    return emptyState(today);
  }

  const state = raw as Partial<TokenBudgetState>;
  if (state.version !== CURRENT_VERSION) {
    return emptyState(today);
  }

  if (!state.usage || typeof state.usage !== "object" || state.usage.date !== today) {
    // Day has rolled over — reset counters.
    return emptyState(today);
  }

  // Validate the tiers map.
  const tiers: Record<string, number> = {};
  if (state.usage.tiers && typeof state.usage.tiers === "object") {
    for (const [key, value] of Object.entries(state.usage.tiers)) {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        tiers[key] = value;
      }
    }
  }

  return {
    version: CURRENT_VERSION,
    usage: { date: today, tiers },
  };
}

/** Persist budget state to disk. */
export function saveBudgetState(state: TokenBudgetState, stateDir?: string): void {
  const filePath = resolveStatePath(stateDir);
  saveJsonFile(filePath, state);
}

/** Check whether a tier's daily budget has been exhausted. */
export function isBudgetExhausted(state: TokenBudgetState, tier: TokenBudgetTier): boolean {
  const key = tierKey(tier.provider, tier.model);
  const used = state.usage.tiers[key] ?? 0;
  return used >= tier.dailyTokenLimit;
}

/**
 * Record token usage for a provider/model pair.
 * Mutates the state in place; caller is responsible for persisting.
 */
export function recordBudgetUsage(
  state: TokenBudgetState,
  provider: string,
  model: string,
  tokens: number,
): void {
  if (tokens <= 0 || !Number.isFinite(tokens)) {
    return;
  }
  const key = tierKey(provider, model);
  state.usage.tiers[key] = (state.usage.tiers[key] ?? 0) + tokens;
}

/**
 * Walk the tier list in order and return the first tier whose daily
 * budget has not been exhausted. Returns `null` when all tiers are
 * spent, signalling that the primary model should be used.
 */
export function resolveActiveTier(
  config: TokenBudgetConfig,
  state: TokenBudgetState,
): TokenBudgetTier | null {
  for (const tier of config.tiers) {
    if (!isBudgetExhausted(state, tier)) {
      return tier;
    }
  }
  return null;
}

/**
 * If the stored date does not match today, return a fresh state for
 * today (daily reset). Otherwise return the state unchanged.
 */
export function resetIfNewDay(
  state: TokenBudgetState,
  resetTime?: TokenBudgetConfig["resetTime"],
): TokenBudgetState {
  const today = resolveBudgetDate(resetTime);
  if (state.usage.date === today) {
    return state;
  }
  return emptyState(today);
}
