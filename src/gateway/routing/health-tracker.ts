interface CallResult {
  timestamp: number;
  success: boolean;
  latencyMs: number;
  error?: string; // "timeout" | "rate_limit" | "error"
}

interface ModelHealth {
  results: CallResult[];
  lastUpdated: number;
}

export class HealthTracker {
  private store: Map<string, ModelHealth> = new Map();
  private windowSize: number;

  constructor(windowSize = 20) {
    this.windowSize = windowSize;
  }

  recordResult(model: string, result: CallResult): void {
    const health = this.store.get(model) ?? { results: [], lastUpdated: 0 };
    health.results.push(result);
    if (health.results.length > this.windowSize) {
      health.results.shift();
    }
    health.lastUpdated = Date.now();
    this.store.set(model, health);
  }

  getHealthScore(model: string): number {
    const health = this.store.get(model);
    if (!health || health.results.length === 0) {
      return 1.0; // default healthy
    }

    let penalty = 0;
    for (const r of health.results) {
      if (!r.success) {
        if (r.error === "timeout") {
          // timeout penalty: 0.2/windowSize
          penalty += 0.2 / this.windowSize;
        } else {
          // failure penalty: 0.3/windowSize
          penalty += 0.3 / this.windowSize;
        }
      }
      // high latency penalty: > 30s -> 0.1/windowSize * (latencyMs/60000)
      if (r.latencyMs > 30_000) {
        penalty += (0.1 / this.windowSize) * (r.latencyMs / 60_000);
      }
    }

    return Math.max(0, Math.min(1, 1 - penalty));
  }

  isHealthy(model: string, threshold: number): boolean {
    return this.getHealthScore(model) >= threshold;
  }

  serialize(): string {
    const obj: Record<string, ModelHealth> = {};
    for (const [key, value] of this.store.entries()) {
      obj[key] = value;
    }
    return JSON.stringify(obj);
  }

  deserialize(data: string): void {
    const obj = JSON.parse(data) as Record<string, ModelHealth>;
    this.store.clear();
    for (const [key, value] of Object.entries(obj)) {
      this.store.set(key, value);
    }
  }
}
