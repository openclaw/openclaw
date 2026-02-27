/**
 * Anomaly Detection - Phase 6 Security Monitoring & Detection
 *
 * Z-score baseline engine for statistical anomaly detection.
 * No external dependencies - pure math implementation.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { emitSecurityEvent } from "./security-events.js";

const log = createSubsystemLogger("security/anomaly-detection");

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface AnomalyDetectionConfig {
  /** Whether anomaly detection is enabled (default: false) */
  enabled?: boolean;
  /** Z-score threshold for anomaly flagging (default: 3.0) */
  sensitivity?: number;
  /** Minimum data points before baseline is established (default: 10) */
  minDataPoints?: number;
  /** Window size for rolling statistics (default: 100) */
  windowSize?: number;
  /** Decay factor for exponential moving average (0-1, default: 0.1) */
  decayFactor?: number;
}

export interface MetricPoint {
  value: number;
  timestamp: number;
}

export interface MetricStats {
  mean: number;
  stdDev: number;
  count: number;
  min: number;
  max: number;
  lastValue: number | null;
  lastTimestamp: number | null;
}

export interface AnomalyResult {
  isAnomaly: boolean;
  zScore: number;
  value: number;
  mean: number;
  stdDev: number;
  message?: string;
}

// -----------------------------------------------------------------------------
// Numeric Ring Buffer (used by RollingStats for O(1) window maintenance)
// -----------------------------------------------------------------------------

/** Fixed-capacity numeric ring buffer — O(1) push, avoids O(n) Array.shift(). */
class NumericRingBuffer {
  private readonly buf: Float64Array;
  private head = 0;
  private _size = 0;
  readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.buf = new Float64Array(capacity);
  }

  push(value: number): void {
    this.buf[this.head] = value;
    this.head = (this.head + 1) % this.capacity;
    if (this._size < this.capacity) {
      this._size++;
    }
  }

  get size(): number {
    return this._size;
  }

  /** Returns values in insertion order (oldest first). */
  toArray(): number[] {
    if (this._size < this.capacity) {
      return Array.from(this.buf.subarray(0, this._size));
    }
    return Array.from<unknown, number>(
      { length: this.capacity },
      (_, i) => this.buf[(this.head + i) % this.capacity],
    );
  }

  reset(): void {
    this.buf.fill(0);
    this.head = 0;
    this._size = 0;
  }
}

// -----------------------------------------------------------------------------
// Rolling Statistics Calculator
// -----------------------------------------------------------------------------

/**
 * Welford's online algorithm for computing running mean and variance.
 * Memory-efficient O(1) space, numerically stable.
 */
export class RollingStats {
  private count = 0;
  private mean = 0;
  private m2 = 0; // Sum of squared differences from mean
  private min = Infinity;
  private max = -Infinity;
  private lastValue: number | null = null;
  private lastTimestamp: number | null = null;

  // For windowed calculations — O(1) push via ring buffer (BP-13)
  private windowSize: number;
  private values: NumericRingBuffer;

  constructor(windowSize = 100) {
    this.windowSize = windowSize;
    this.values = new NumericRingBuffer(windowSize);
  }

  /**
   * Add a new data point.
   */
  add(value: number, timestamp?: number): void {
    this.count++;
    this.lastValue = value;
    this.lastTimestamp = timestamp ?? Date.now();

    // Update min/max
    if (value < this.min) {
      this.min = value;
    }
    if (value > this.max) {
      this.max = value;
    }

    // Welford's algorithm for online mean and variance
    const delta = value - this.mean;
    this.mean += delta / this.count;
    const delta2 = value - this.mean;
    this.m2 += delta * delta2;

    // Maintain rolling window — O(1) push, no Array.shift()
    this.values.push(value);
  }

  /**
   * Get population variance.
   */
  variance(): number {
    if (this.count < 2) {
      return 0;
    }
    return this.m2 / this.count;
  }

  /**
   * Get population standard deviation.
   */
  stdDev(): number {
    return Math.sqrt(this.variance());
  }

  /**
   * Get sample variance (Bessel's correction).
   */
  sampleVariance(): number {
    if (this.count < 2) {
      return 0;
    }
    return this.m2 / (this.count - 1);
  }

  /**
   * Get sample standard deviation.
   */
  sampleStdDev(): number {
    return Math.sqrt(this.sampleVariance());
  }

  /**
   * Get windowed mean (only from recent values).
   */
  windowedMean(): number {
    if (this.values.size === 0) {
      return 0;
    }
    const arr = this.values.toArray();
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  /**
   * Get windowed standard deviation.
   */
  windowedStdDev(): number {
    if (this.values.size < 2) {
      return 0;
    }
    const arr = this.values.toArray();
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const sumSquaredDiff = arr.reduce((acc, val) => acc + (val - mean) ** 2, 0);
    return Math.sqrt(sumSquaredDiff / arr.length);
  }

  /**
   * Calculate Z-score for a value using windowed stats.
   */
  zScore(value: number): number {
    const mean = this.windowedMean();
    const std = this.windowedStdDev();
    if (std === 0) {
      return 0;
    }
    return (value - mean) / std;
  }

  /**
   * Get all statistics.
   */
  getStats(): MetricStats {
    return {
      mean: this.mean,
      stdDev: this.stdDev(),
      count: this.count,
      min: this.min === Infinity ? 0 : this.min,
      max: this.max === -Infinity ? 0 : this.max,
      lastValue: this.lastValue,
      lastTimestamp: this.lastTimestamp,
    };
  }

  /**
   * Reset all statistics.
   */
  reset(): void {
    this.count = 0;
    this.mean = 0;
    this.m2 = 0;
    this.min = Infinity;
    this.max = -Infinity;
    this.lastValue = null;
    this.lastTimestamp = null;
    this.values.reset();
  }
}

// -----------------------------------------------------------------------------
// Exponential Moving Average
// -----------------------------------------------------------------------------

/**
 * Exponential Moving Average with configurable decay.
 */
export class ExponentialMovingAverage {
  private value: number | null = null;
  private decayFactor: number;

  constructor(decayFactor = 0.1) {
    if (decayFactor <= 0 || decayFactor > 1) {
      throw new Error("Decay factor must be between 0 (exclusive) and 1 (inclusive)");
    }
    this.decayFactor = decayFactor;
  }

  /**
   * Update EMA with new value.
   */
  update(value: number): number {
    if (this.value === null) {
      this.value = value;
    } else {
      this.value = this.decayFactor * value + (1 - this.decayFactor) * this.value;
    }
    return this.value;
  }

  /**
   * Get current EMA value.
   */
  get(): number | null {
    return this.value;
  }

  /**
   * Reset EMA.
   */
  reset(): void {
    this.value = null;
  }
}

// -----------------------------------------------------------------------------
// Anomaly Detector
// -----------------------------------------------------------------------------

/**
 * Anomaly detector using Z-score analysis.
 */
export class AnomalyDetector {
  private config: Required<AnomalyDetectionConfig>;
  private metrics = new Map<string, RollingStats>();
  private emas = new Map<string, ExponentialMovingAverage>();

  constructor(config?: AnomalyDetectionConfig) {
    this.config = {
      enabled: config?.enabled ?? false,
      sensitivity: config?.sensitivity ?? 3.0,
      minDataPoints: config?.minDataPoints ?? 10,
      windowSize: config?.windowSize ?? 100,
      decayFactor: config?.decayFactor ?? 0.1,
    };
  }

  /**
   * Check if anomaly detection is enabled.
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Record a metric value and check for anomaly.
   */
  record(metricName: string, value: number, timestamp?: number): AnomalyResult {
    // Get or create stats for this metric
    let stats = this.metrics.get(metricName);
    if (!stats) {
      stats = new RollingStats(this.config.windowSize);
      this.metrics.set(metricName, stats);
    }

    // Get or create EMA
    let ema = this.emas.get(metricName);
    if (!ema) {
      ema = new ExponentialMovingAverage(this.config.decayFactor);
      this.emas.set(metricName, ema);
    }

    // Add to stats
    stats.add(value, timestamp);
    ema.update(value);

    // Check for anomaly
    const metricStats = stats.getStats();

    // Need minimum data points before flagging anomalies
    if (metricStats.count < this.config.minDataPoints) {
      return {
        isAnomaly: false,
        zScore: 0,
        value,
        mean: metricStats.mean,
        stdDev: metricStats.stdDev,
      };
    }

    // Calculate Z-score using windowed stats
    const zScore = stats.zScore(value);
    const absZScore = Math.abs(zScore);
    const isAnomaly = this.config.enabled && absZScore >= this.config.sensitivity;

    const result: AnomalyResult = {
      isAnomaly,
      zScore,
      value,
      mean: stats.windowedMean(),
      stdDev: stats.windowedStdDev(),
    };

    if (isAnomaly) {
      const direction = zScore > 0 ? "above" : "below";
      result.message = `${metricName} value ${value.toFixed(2)} is ${absZScore.toFixed(1)} standard deviations ${direction} mean`;

      log.warn("anomaly detected", {
        metric: metricName,
        value,
        zScore,
        mean: result.mean,
        stdDev: result.stdDev,
      });
    }

    return result;
  }

  /**
   * Record multiple metrics at once.
   */
  recordBatch(metrics: Record<string, number>, timestamp?: number): Record<string, AnomalyResult> {
    const results: Record<string, AnomalyResult> = {};
    for (const [name, value] of Object.entries(metrics)) {
      results[name] = this.record(name, value, timestamp);
    }
    return results;
  }

  /**
   * Get statistics for a metric.
   */
  getMetricStats(metricName: string): MetricStats | null {
    const stats = this.metrics.get(metricName);
    return stats ? stats.getStats() : null;
  }

  /**
   * Get all tracked metric names.
   */
  getTrackedMetrics(): string[] {
    return Array.from(this.metrics.keys());
  }

  /**
   * Get EMA value for a metric.
   */
  getEMA(metricName: string): number | null {
    return this.emas.get(metricName)?.get() ?? null;
  }

  /**
   * Reset a specific metric.
   */
  resetMetric(metricName: string): void {
    this.metrics.delete(metricName);
    this.emas.delete(metricName);
  }

  /**
   * Reset all metrics.
   */
  resetAll(): void {
    this.metrics.clear();
    this.emas.clear();
  }

  /**
   * Update config at runtime.
   */
  updateConfig(config: Partial<AnomalyDetectionConfig>): void {
    if (config.enabled !== undefined) {
      this.config.enabled = config.enabled;
    }
    if (config.sensitivity !== undefined) {
      this.config.sensitivity = config.sensitivity;
    }
    if (config.minDataPoints !== undefined) {
      this.config.minDataPoints = config.minDataPoints;
    }
    if (config.decayFactor !== undefined) {
      this.config.decayFactor = config.decayFactor;
    }
    // Window size changes require metric reset
    if (config.windowSize !== undefined && config.windowSize !== this.config.windowSize) {
      this.config.windowSize = config.windowSize;
      // Re-create rolling stats with new window size
      for (const [name] of this.metrics) {
        this.metrics.set(name, new RollingStats(config.windowSize));
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Credential Access Anomaly Detector
// -----------------------------------------------------------------------------

/**
 * Specialized detector for credential access patterns.
 */
export class CredentialAccessDetector {
  private detector: AnomalyDetector;
  private accessCounts = new Map<string, { count: number; lastReset: number }>();
  private readonly resetIntervalMs = 60_000; // 1 minute buckets

  constructor(config?: AnomalyDetectionConfig) {
    this.detector = new AnomalyDetector({
      ...config,
      minDataPoints: config?.minDataPoints ?? 5,
      sensitivity: config?.sensitivity ?? 2.5,
    });
  }

  /**
   * Record a credential access.
   */
  recordAccess(credentialName: string, scope: string): AnomalyResult | null {
    if (!this.detector.isEnabled()) {
      return null;
    }

    const key = `${scope}:${credentialName}`;
    const now = Date.now();

    // Get or create counter
    let counter = this.accessCounts.get(key);
    if (!counter || now - counter.lastReset >= this.resetIntervalMs) {
      // New minute bucket - record previous bucket if exists
      if (counter) {
        const result = this.detector.record(`credential_access:${key}`, counter.count);
        if (result.isAnomaly) {
          this.emitSpikeEvent(key, counter.count, result);
        }
      }
      counter = { count: 0, lastReset: now };
      this.accessCounts.set(key, counter);
    }

    counter.count++;
    return null; // Anomaly check happens on bucket boundary
  }

  /**
   * Flush all pending buckets (call periodically or on shutdown).
   */
  flush(): void {
    const now = Date.now();
    for (const [key, counter] of this.accessCounts.entries()) {
      if (now - counter.lastReset >= this.resetIntervalMs) {
        const result = this.detector.record(`credential_access:${key}`, counter.count);
        if (result.isAnomaly) {
          this.emitSpikeEvent(key, counter.count, result);
        }
      }
    }
    this.accessCounts.clear();
  }

  /**
   * Get access statistics for a credential.
   */
  getAccessStats(credentialName: string, scope: string): MetricStats | null {
    return this.detector.getMetricStats(`credential_access:${scope}:${credentialName}`);
  }

  private emitSpikeEvent(key: string, count: number, result: AnomalyResult): void {
    emitSecurityEvent({
      type: "credential_access_spike",
      severity: result.zScore > 4 ? "critical" : "warn",
      source: "anomaly-detection",
      message: `Credential access spike: ${count} accesses/minute for ${key}`,
      details: {
        credential: key,
        accessCount: count,
        zScore: result.zScore,
        mean: result.mean,
        stdDev: result.stdDev,
      },
      remediation: "Investigate the source of credential access requests",
    });
  }
}

// -----------------------------------------------------------------------------
// Singleton Instance
// -----------------------------------------------------------------------------

let defaultDetector: AnomalyDetector | undefined;
let defaultCredentialDetector: CredentialAccessDetector | undefined;

/**
 * Get or create the default AnomalyDetector instance.
 *
 * **Config is only accepted on the first call.** Subsequent calls with a
 * `config` argument will log a warning and return the already-initialised
 * singleton unchanged. Configure this singleton exactly once, at application
 * startup, before any other subsystem calls it.
 */
export function getAnomalyDetector(config?: AnomalyDetectionConfig): AnomalyDetector {
  if (!defaultDetector) {
    defaultDetector = new AnomalyDetector(config);
  } else if (config !== undefined) {
    log.warn(
      "getAnomalyDetector() called again with config — singleton already initialized; config ignored",
    );
  }
  return defaultDetector;
}

/**
 * Get or create the default CredentialAccessDetector instance.
 */
export function getCredentialAccessDetector(
  config?: AnomalyDetectionConfig,
): CredentialAccessDetector {
  if (!defaultCredentialDetector) {
    defaultCredentialDetector = new CredentialAccessDetector(config);
  }
  return defaultCredentialDetector;
}

/**
 * Reset default instances (for testing).
 */
export function resetAnomalyDetectors(): void {
  defaultDetector = undefined;
  defaultCredentialDetector = undefined;
}
