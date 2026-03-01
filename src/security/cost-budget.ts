/**
 * Best-effort per-sender daily cost budget tracker.
 *
 * Tracks estimated API costs (in cents) per composite key. Resets daily at
 * a configurable UTC hour. This is a guardrail, not a billing system.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CostBudgetConfig = {
  /** Master switch. @default false */
  enabled?: boolean;
  /** Maximum daily spend per sender in cents (e.g. 500 = $5.00/day). @default 500 */
  maxDailyCostCents?: number;
  /** Maximum cost per single message in cents. @default 100 */
  maxPerMessageCostCents?: number;
  /** UTC hour at which daily budgets reset (0–23). @default 0 */
  resetHourUtc?: number;
};

export type CostBudgetStatus = {
  dailySpentCents: number;
  dailyRemainingCents: number;
  overBudget: boolean;
};

export type CostBudgetTracker = {
  /** Record a cost (in cents) for the given sender key. */
  recordCost(key: string, costCents: number): void;
  /** Check the current budget status for a sender key. */
  checkBudget(key: string): CostBudgetStatus;
  /** Reset budget for a single sender key. */
  reset(key: string): void;
  /** Dispose and cancel periodic timers. */
  dispose(): void;
};

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_MAX_DAILY_CENTS = 500;
const DEFAULT_MAX_PER_MESSAGE_CENTS = 100;
const DEFAULT_RESET_HOUR_UTC = 0;
const RESET_CHECK_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------------------
// Internal entry
// ---------------------------------------------------------------------------

type BudgetEntry = {
  spentCents: number;
  /** The UTC day string (YYYY-MM-DD) this budget period covers. */
  dayKey: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function currentDayKey(resetHourUtc: number): string {
  const now = new Date();
  const adjustedMs = now.getTime() - resetHourUtc * 3_600_000;
  const adjusted = new Date(adjustedMs);
  return adjusted.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function createCostBudgetTracker(config?: CostBudgetConfig): CostBudgetTracker {
  const enabled = config?.enabled === true;
  const maxDailyCents = config?.maxDailyCostCents ?? DEFAULT_MAX_DAILY_CENTS;
  const _maxPerMessageCents = config?.maxPerMessageCostCents ?? DEFAULT_MAX_PER_MESSAGE_CENTS;
  const resetHourUtc = config?.resetHourUtc ?? DEFAULT_RESET_HOUR_UTC;

  const entries = new Map<string, BudgetEntry>();

  // Periodic check to auto-reset expired day entries.
  const resetTimer = enabled ? setInterval(() => autoReset(), RESET_CHECK_INTERVAL_MS) : null;
  if (resetTimer) {
    resetTimer.unref();
  }

  function ensureEntry(key: string): BudgetEntry {
    const dayKey = currentDayKey(resetHourUtc);
    let entry = entries.get(key);
    if (!entry || entry.dayKey !== dayKey) {
      entry = { spentCents: 0, dayKey };
      entries.set(key, entry);
    }
    return entry;
  }

  function autoReset(): void {
    const dayKey = currentDayKey(resetHourUtc);
    for (const [key, entry] of entries) {
      if (entry.dayKey !== dayKey) {
        entries.delete(key);
      }
    }
  }

  function recordCost(key: string, costCents: number): void {
    if (!enabled) {
      return;
    }
    const clamped = Math.min(Math.max(0, costCents), _maxPerMessageCents);
    const entry = ensureEntry(key);
    entry.spentCents += clamped;
  }

  function checkBudget(key: string): CostBudgetStatus {
    if (!enabled) {
      return { dailySpentCents: 0, dailyRemainingCents: maxDailyCents, overBudget: false };
    }
    const entry = ensureEntry(key);
    const remaining = Math.max(0, maxDailyCents - entry.spentCents);
    return {
      dailySpentCents: entry.spentCents,
      dailyRemainingCents: remaining,
      overBudget: entry.spentCents >= maxDailyCents,
    };
  }

  function reset(key: string): void {
    entries.delete(key);
  }

  function dispose(): void {
    if (resetTimer) {
      clearInterval(resetTimer);
    }
    entries.clear();
  }

  return { recordCost, checkBudget, reset, dispose };
}
