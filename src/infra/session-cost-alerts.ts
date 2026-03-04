/**
 * Session Cost Alert Thresholds
 *
 * Monitors session cost accumulation and triggers alerts when configurable
 * thresholds are reached. Supports multiple threshold levels (warning, critical)
 * and tracks which thresholds have already fired to avoid duplicate alerts.
 */

export type AlertLevel = "warning" | "critical";

export type CostAlertThreshold = {
  /** Alert level */
  level: AlertLevel;
  /** Cost threshold in USD */
  costUsd: number;
  /** Optional: token threshold (triggers on whichever is hit first) */
  tokens?: number;
};

export type CostAlertEvent = {
  level: AlertLevel;
  sessionId: string;
  currentCostUsd: number;
  thresholdCostUsd: number;
  currentTokens: number;
  thresholdTokens?: number;
  triggeredAt: number;
  message: string;
};

export type CostAlertCallback = (event: CostAlertEvent) => void | Promise<void>;

export type SessionCostAlertConfig = {
  /** Thresholds to monitor. Default: warning at $0.50, critical at $2.00 */
  thresholds?: CostAlertThreshold[];
  /** Whether alerts are enabled. Default: true */
  enabled?: boolean;
  /** Callback invoked when a threshold is crossed */
  onAlert?: CostAlertCallback;
};

const DEFAULT_THRESHOLDS: CostAlertThreshold[] = [
  { level: "warning", costUsd: 0.5 },
  { level: "critical", costUsd: 2.0 },
];

type FiredState = {
  level: AlertLevel;
  firedAt: number;
  costAtFiring: number;
};

export class SessionCostAlertMonitor {
  private readonly thresholds: CostAlertThreshold[];
  private readonly enabled: boolean;
  private readonly onAlert?: CostAlertCallback;

  /** Tracks which thresholds have already fired per session */
  private firedMap = new Map<string, Map<string, FiredState>>();

  constructor(config?: SessionCostAlertConfig) {
    this.thresholds = (config?.thresholds ?? DEFAULT_THRESHOLDS).toSorted(
      (a, b) => a.costUsd - b.costUsd,
    );
    this.enabled = config?.enabled ?? true;
    this.onAlert = config?.onAlert;
  }

  /**
   * Check if any thresholds have been crossed for a session.
   * Returns newly triggered alerts (if any).
   */
  check(params: {
    sessionId: string;
    currentCostUsd: number;
    currentTokens: number;
  }): CostAlertEvent[] {
    if (!this.enabled) {
      return [];
    }

    const { sessionId, currentCostUsd, currentTokens } = params;
    const fired = this.firedMap.get(sessionId) ?? new Map<string, FiredState>();
    const newAlerts: CostAlertEvent[] = [];

    for (const threshold of this.thresholds) {
      const key = `${threshold.level}:${threshold.costUsd}`;
      if (fired.has(key)) {
        continue;
      }

      const costTriggered = currentCostUsd >= threshold.costUsd;
      const tokenTriggered =
        threshold.tokens !== undefined && currentTokens >= threshold.tokens;

      if (!costTriggered && !tokenTriggered) {
        continue;
      }

      const event: CostAlertEvent = {
        level: threshold.level,
        sessionId,
        currentCostUsd,
        thresholdCostUsd: threshold.costUsd,
        currentTokens,
        thresholdTokens: threshold.tokens,
        triggeredAt: Date.now(),
        message: `Session ${sessionId} reached ${threshold.level} threshold: $${currentCostUsd.toFixed(4)} >= $${threshold.costUsd.toFixed(2)}`,
      };

      fired.set(key, {
        level: threshold.level,
        firedAt: event.triggeredAt,
        costAtFiring: currentCostUsd,
      });

      newAlerts.push(event);

      // Fire callback (non-blocking)
      if (this.onAlert) {
        try {
          const result = this.onAlert(event);
          if (result instanceof Promise) {
            result.catch(() => {}); // Swallow async errors
          }
        } catch {
          // Swallow sync errors
        }
      }
    }

    if (fired.size > 0) {
      this.firedMap.set(sessionId, fired);
    }

    return newAlerts;
  }

  /** Check if a specific threshold level has already fired for a session. */
  hasFired(sessionId: string, level: AlertLevel): boolean {
    const fired = this.firedMap.get(sessionId);
    if (!fired) {
      return false;
    }
    for (const [, state] of fired) {
      if (state.level === level) {
        return true;
      }
    }
    return false;
  }

  /** Reset alert state for a session (e.g., when session ends). */
  resetSession(sessionId: string): void {
    this.firedMap.delete(sessionId);
  }

  /** Reset all alert state. */
  resetAll(): void {
    this.firedMap.clear();
  }

  /** Get the configured thresholds. */
  getThresholds(): readonly CostAlertThreshold[] {
    return this.thresholds;
  }
}

// Singleton for the default monitor
let defaultMonitor: SessionCostAlertMonitor | undefined;

export function getDefaultCostAlertMonitor(
  config?: SessionCostAlertConfig,
): SessionCostAlertMonitor {
  if (!defaultMonitor) {
    defaultMonitor = new SessionCostAlertMonitor(config);
  }
  return defaultMonitor;
}

export function resetDefaultCostAlertMonitor(): void {
  defaultMonitor?.resetAll();
  defaultMonitor = undefined;
}
