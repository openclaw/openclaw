/**
 * LLM Gateway Metrics - Prometheus-compatible metrics collection
 */

import type { GatewayMetrics, TierLevel, TokenUsage } from "./types.js";

/**
 * Metrics collector with Prometheus export format
 */
export class MetricsCollector {
  private metrics: GatewayMetrics;
  private histograms: Map<string, number[]>;
  private startTime: number;

  constructor() {
    this.metrics = this.initializeMetrics();
    this.histograms = new Map();
    this.startTime = Date.now();
  }

  private initializeMetrics(): GatewayMetrics {
    return {
      requestsTotal: 0,
      requestsByTier: {
        local: 0,
        cheap: 0,
        premium: 0,
      },
      cacheHits: 0,
      cacheMisses: 0,
      totalCost: 0,
      avgLatencyMs: 0,
      errorsTotal: 0,
      tokensByTier: {
        local: { prompt: 0, completion: 0 },
        cheap: { prompt: 0, completion: 0 },
        premium: { prompt: 0, completion: 0 },
      },
    };
  }

  /**
   * Record a request
   */
  recordRequest(tier: TierLevel, latencyMs: number, cost: number, usage: TokenUsage): void {
    this.metrics.requestsTotal++;
    this.metrics.requestsByTier[tier]++;
    this.metrics.totalCost += cost;
    this.metrics.tokensByTier[tier].prompt += usage.promptTokens;
    this.metrics.tokensByTier[tier].completion += usage.completionTokens;

    // Update latency histogram
    this.addToHistogram("latency_ms", latencyMs);

    // Recalculate average latency
    const latencies = this.histograms.get("latency_ms") || [];
    this.metrics.avgLatencyMs = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  }

  /**
   * Record a cache hit
   */
  recordCacheHit(): void {
    this.metrics.cacheHits++;
  }

  /**
   * Record a cache miss
   */
  recordCacheMiss(): void {
    this.metrics.cacheMisses++;
  }

  /**
   * Record an error
   */
  recordError(tier: TierLevel, errorType: string): void {
    this.metrics.errorsTotal++;
    this.addToHistogram(`errors_${errorType}`, 1);
  }

  /**
   * Get current metrics
   */
  getMetrics(): GatewayMetrics {
    return { ...this.metrics };
  }

  /**
   * Export metrics in Prometheus format
   */
  exportPrometheus(): string {
    const lines: string[] = [];
    const uptime = (Date.now() - this.startTime) / 1000;

    // Gateway info
    lines.push("# HELP llm_gateway_info Gateway information");
    lines.push("# TYPE llm_gateway_info gauge");
    lines.push(`llm_gateway_info{version="1.0.0"} 1`);

    // Uptime
    lines.push("");
    lines.push("# HELP llm_gateway_uptime_seconds Gateway uptime in seconds");
    lines.push("# TYPE llm_gateway_uptime_seconds gauge");
    lines.push(`llm_gateway_uptime_seconds ${uptime}`);

    // Total requests
    lines.push("");
    lines.push("# HELP llm_gateway_requests_total Total number of requests");
    lines.push("# TYPE llm_gateway_requests_total counter");
    lines.push(`llm_gateway_requests_total ${this.metrics.requestsTotal}`);

    // Requests by tier
    lines.push("");
    lines.push("# HELP llm_gateway_requests_by_tier Requests by tier");
    lines.push("# TYPE llm_gateway_requests_by_tier counter");
    for (const [tier, count] of Object.entries(this.metrics.requestsByTier)) {
      lines.push(`llm_gateway_requests_by_tier{tier="${tier}"} ${String(count)}`);
    }

    // Cache metrics
    lines.push("");
    lines.push("# HELP llm_gateway_cache_hits_total Cache hits");
    lines.push("# TYPE llm_gateway_cache_hits_total counter");
    lines.push(`llm_gateway_cache_hits_total ${this.metrics.cacheHits}`);

    lines.push("");
    lines.push("# HELP llm_gateway_cache_misses_total Cache misses");
    lines.push("# TYPE llm_gateway_cache_misses_total counter");
    lines.push(`llm_gateway_cache_misses_total ${this.metrics.cacheMisses}`);

    // Cache hit rate
    const totalCache = this.metrics.cacheHits + this.metrics.cacheMisses;
    const hitRate = totalCache > 0 ? this.metrics.cacheHits / totalCache : 0;
    lines.push("");
    lines.push("# HELP llm_gateway_cache_hit_rate Cache hit rate");
    lines.push("# TYPE llm_gateway_cache_hit_rate gauge");
    lines.push(`llm_gateway_cache_hit_rate ${hitRate.toFixed(4)}`);

    // Cost metrics
    lines.push("");
    lines.push("# HELP llm_gateway_cost_total Total cost in USD");
    lines.push("# TYPE llm_gateway_cost_total counter");
    lines.push(`llm_gateway_cost_total ${this.metrics.totalCost.toFixed(6)}`);

    // Cost per request
    const costPerRequest =
      this.metrics.requestsTotal > 0 ? this.metrics.totalCost / this.metrics.requestsTotal : 0;
    lines.push("");
    lines.push("# HELP llm_gateway_cost_per_request Average cost per request");
    lines.push("# TYPE llm_gateway_cost_per_request gauge");
    lines.push(`llm_gateway_cost_per_request ${costPerRequest.toFixed(6)}`);

    // Latency metrics
    lines.push("");
    lines.push("# HELP llm_gateway_latency_ms Average latency in milliseconds");
    lines.push("# TYPE llm_gateway_latency_ms gauge");
    lines.push(`llm_gateway_latency_ms ${this.metrics.avgLatencyMs.toFixed(2)}`);

    // Latency histogram
    const latencyHistogram = this.getHistogramBuckets(
      "latency_ms",
      [100, 250, 500, 1000, 2000, 5000],
    );
    lines.push("");
    lines.push("# HELP llm_gateway_latency_bucket Latency histogram buckets");
    lines.push("# TYPE llm_gateway_latency_bucket histogram");
    for (const [bucket, count] of Object.entries(latencyHistogram)) {
      lines.push(`llm_gateway_latency_bucket{le="${bucket}"} ${count}`);
    }
    lines.push(`llm_gateway_latency_bucket{le="+Inf"} ${this.metrics.requestsTotal}`);
    lines.push(`llm_gateway_latency_sum ${this.getHistogramSum("latency_ms")}`);
    lines.push(`llm_gateway_latency_count ${this.metrics.requestsTotal}`);

    // Error metrics
    lines.push("");
    lines.push("# HELP llm_gateway_errors_total Total errors");
    lines.push("# TYPE llm_gateway_errors_total counter");
    lines.push(`llm_gateway_errors_total ${this.metrics.errorsTotal}`);

    // Token usage by tier
    lines.push("");
    lines.push("# HELP llm_gateway_tokens_total Token usage by tier");
    lines.push("# TYPE llm_gateway_tokens_total counter");
    for (const [tier, usage] of Object.entries(this.metrics.tokensByTier)) {
      const typedUsage = usage as { prompt: number; completion: number };
      lines.push(`llm_gateway_tokens_total{tier="${tier}",type="prompt"} ${typedUsage.prompt}`);
      lines.push(
        `llm_gateway_tokens_total{tier="${tier}",type="completion"} ${typedUsage.completion}`,
      );
    }

    // Cost savings estimation (compared to always using premium)
    const premiumCostPer1k = 0.25; // Average premium cost
    const cheapCostPer1k = 0.0001; // Average cheap cost
    const _cheapRequests = this.metrics.requestsByTier.cheap;
    const cheapTokens =
      this.metrics.tokensByTier.cheap.prompt + this.metrics.tokensByTier.cheap.completion;

    const potentialPremiumCost = (cheapTokens / 1000) * premiumCostPer1k;
    const actualCheapCost = (cheapTokens / 1000) * cheapCostPer1k;
    const savings = potentialPremiumCost - actualCheapCost;

    lines.push("");
    lines.push("# HELP llm_gateway_cost_savings_usd Estimated cost savings vs premium-only");
    lines.push("# TYPE llm_gateway_cost_savings_usd gauge");
    lines.push(`llm_gateway_cost_savings_usd ${savings.toFixed(6)}`);

    return lines.join("\n");
  }

  /**
   * Export metrics as JSON
   */
  exportJSON(): Record<string, unknown> {
    const totalCache = this.metrics.cacheHits + this.metrics.cacheMisses;
    const hitRate = totalCache > 0 ? this.metrics.cacheHits / totalCache : 0;
    const costPerRequest =
      this.metrics.requestsTotal > 0 ? this.metrics.totalCost / this.metrics.requestsTotal : 0;

    return {
      uptime_seconds: (Date.now() - this.startTime) / 1000,
      requests: {
        total: this.metrics.requestsTotal,
        by_tier: this.metrics.requestsByTier,
        errors: this.metrics.errorsTotal,
        error_rate:
          this.metrics.requestsTotal > 0
            ? this.metrics.errorsTotal / this.metrics.requestsTotal
            : 0,
      },
      cache: {
        hits: this.metrics.cacheHits,
        misses: this.metrics.cacheMisses,
        hit_rate: hitRate,
      },
      cost: {
        total: this.metrics.totalCost,
        per_request: costPerRequest,
      },
      latency: {
        avg_ms: this.metrics.avgLatencyMs,
        histogram: this.getHistogramBuckets("latency_ms", [100, 250, 500, 1000, 2000, 5000]),
      },
      tokens: this.metrics.tokensByTier,
    };
  }

  /**
   * Reset all metrics
   */
  reset(): void {
    this.metrics = this.initializeMetrics();
    this.histograms.clear();
    this.startTime = Date.now();
  }

  /**
   * Add value to histogram
   */
  private addToHistogram(name: string, value: number): void {
    const histogram = this.histograms.get(name) || [];
    histogram.push(value);

    // Keep only last 10000 values for memory efficiency
    if (histogram.length > 10000) {
      histogram.shift();
    }

    this.histograms.set(name, histogram);
  }

  /**
   * Get histogram buckets
   */
  private getHistogramBuckets(name: string, buckets: number[]): Record<string, number> {
    const histogram = this.histograms.get(name) || [];
    const result: Record<string, number> = {};

    for (const bucket of buckets) {
      const count = histogram.filter((v) => v <= bucket).length;
      result[bucket.toString()] = count;
    }

    return result;
  }

  /**
   * Get histogram sum
   */
  private getHistogramSum(name: string): number {
    const histogram = this.histograms.get(name) || [];
    return histogram.reduce((a, b) => a + b, 0);
  }
}

/**
 * Prometheus HTTP handler
 */
export function createPrometheusHandler(metrics: MetricsCollector) {
  return async (
    req: Record<string, unknown>,
    res: { setHeader: (name: string, value: string) => void; send: (data: string) => void },
  ) => {
    const prometheusOutput = metrics.exportPrometheus();
    res.setHeader("Content-Type", "text/plain; version=0.0.4");
    res.send(prometheusOutput);
  };
}

/**
 * Create JSON metrics handler
 */
export function createJsonMetricsHandler(metrics: MetricsCollector) {
  return async (
    req: Record<string, unknown>,
    res: { setHeader: (name: string, value: string) => void; send: (data: string) => void },
  ) => {
    const jsonData = metrics.exportJSON();
    res.setHeader("Content-Type", "application/json");
    res.send(jsonData);
  };
}
