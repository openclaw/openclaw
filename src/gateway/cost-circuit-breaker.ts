/**
 * Cost-aware circuit breaker for model API calls.
 *
 * T-IMPACT-002: no controls on model API spending.
 *
 * States:
 *   closed    — normal, all calls allowed
 *   open      — tripped, all calls rejected
 *   half-open — after cooldown, allows one probe call
 *
 * If the probe is not resolved (via recordCost or recordFailure)
 * within probeTimeoutSecs, the breaker auto-fails back to open.
 *
 * Standalone module — wire into the model dispatch layer in a
 * follow-up integration PR.
 */

type BreakerState = "closed" | "open" | "half-open";

interface CostEntry {
  timestamp: number;
  cost: number;
}

interface BreakerConfig {
  costThreshold: number;
  windowSecs: number;
  cooldownSecs: number;
  /** Seconds before an unresolved half-open probe auto-fails. Default: 30. */
  probeTimeoutSecs: number;
  enabled: boolean;
}

const DEFAULT_CONFIG: BreakerConfig = {
  costThreshold: 10.0,
  windowSecs: 3600,
  cooldownSecs: 300,
  probeTimeoutSecs: 30,
  enabled: true,
};

export function createCostCircuitBreaker(
  userConfig?: Partial<BreakerConfig>,
) {
  const config = { ...DEFAULT_CONFIG, ...userConfig };
  const windowMs = config.windowSecs * 1000;
  const cooldownMs = config.cooldownSecs * 1000;
  const probeTimeoutMs = config.probeTimeoutSecs * 1000;

  let state: BreakerState = "closed";
  let entries: CostEntry[] = [];
  let openedAt = 0;
  let probeTimer: ReturnType<typeof setTimeout> | null = null;

  function prune(): void {
    const cutoff = Date.now() - windowMs;
    entries = entries.filter((e) => e.timestamp > cutoff);
  }

  function totalCost(): number {
    prune();
    return entries.reduce((sum, e) => sum + e.cost, 0);
  }

  function trip(): void {
    state = "open";
    openedAt = Date.now();
    clearProbeTimer();
  }

  function clearProbeTimer(): void {
    if (probeTimer) {
      clearTimeout(probeTimer);
      probeTimer = null;
    }
  }

  function startProbeTimer(): void {
    clearProbeTimer();
    probeTimer = setTimeout(() => {
      // Probe was not resolved in time — treat as failure
      if (state === "half-open") {
        trip();
      }
    }, probeTimeoutMs);
    if (probeTimer.unref) probeTimer.unref();
  }

  return {
    get currentState(): BreakerState {
      return state;
    },

    get currentCost(): number {
      return totalCost();
    },

    allowCall(): boolean {
      if (!config.enabled) return true;

      if (state === "closed") return true;

      if (state === "open") {
        if (Date.now() - openedAt >= cooldownMs) {
          state = "half-open";
          startProbeTimer();
          return true;
        }
        return false;
      }

      return false;
    },

    recordCost(cost: number): void {
      clearProbeTimer();
      entries.push({ timestamp: Date.now(), cost });

      const total = totalCost();

      if (state === "half-open") {
        state = total < config.costThreshold ? "closed" : "open";
        if (state === "open") openedAt = Date.now();
        return;
      }

      if (state === "closed" && total >= config.costThreshold) {

        trip();
      }
    },

    recordFailure(): void {
      clearProbeTimer();
      if (state === "half-open") trip();
    },

    /** Reset to closed and clear all cost history. */
    reset(): void {
      state = "closed";
      entries = [];
      openedAt = 0;
      clearProbeTimer();
    },
  };
}
