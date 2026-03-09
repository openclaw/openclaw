/**
 * Chain Memory Backend - Health Monitor
 *
 * Periodically check provider healthHealth status
 *
 * @module health-monitor
 * @author Tutu
 * @date 2026-03-09
 */

import type { HealthStatus, ProviderWrapper } from "./types.js";

/**
 * Health Monitor Configuration
 */
export interface HealthMonitorConfig {
  checkIntervalMs: number; // Health check interval, default 30000ms
  timeoutMs: number; // Check timeout, default 5000ms
  degradationThreshold: number; // Degradation threshold, default 0.3
}

/**
 * Health MonitorMonitor
 */
export class HealthMonitor {
  private config: HealthMonitorConfig;
  private providers: Map<string, ProviderWrapper> = new Map();
  private checkTimer?: NodeJS.Timeout;
  private isRunning: boolean = false;

  constructor(config: Partial<HealthMonitorConfig> = {}) {
    this.config = {
      checkIntervalMs: config.checkIntervalMs ?? 30000,
      timeoutMs: config.timeoutMs ?? 5000,
      degradationThreshold: config.degradationThreshold ?? 0.3,
    };
  }

  /**
   * Register provider
   */
  registerProvider(provider: ProviderWrapper): void {
    this.providers.set(provider.config.name, provider);
  }

  /**
   * Unregister provider
   */
  unregisterProvider(name: string): void {
    this.providers.delete(name);
  }

  /**
   * Start Health Monitor
   */
  start(): void {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.scheduleCheck();
  }

  /**
   * Stop Health Monitor
   */
  stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    if (this.checkTimer) {
      clearTimeout(this.checkTimer);
      this.checkTimer = undefined;
    }
  }

  /**
   * Schedule next check
   */
  private scheduleCheck(): void {
    if (!this.isRunning) {
      return;
    }

    this.checkTimer = setTimeout(async () => {
      await this.performCheck();
      this.scheduleCheck();
    }, this.config.checkIntervalMs);
  }

  /**
   * Perform health check
   */
  private async performCheck(): Promise<void> {
    const checkPromises = Array.from(this.providers.values()).map(async (provider) => {
      try {
        await this.checkProvider(provider);
      } catch (error) {
        // Log error but do not affect other provider checks
        console.error(`Health check failed for ${provider.config.name}:`, error);
      }
    });

    await Promise.allSettled(checkPromises);
  }

  /**
   * Check single provider health using real backend operation
   */
  private async checkProvider(provider: ProviderWrapper): Promise<void> {
    const startTime = Date.now();

    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Health check timeout")), this.config.timeoutMs);
      });

      // Use lightweight search for real backend health check
      // This ensures we actually test the provider's ability to handle requests
      // Using a unique health check query to avoid cache hits
      const healthCheckQuery = `health_check_${Date.now()}`;
      await Promise.race([
        provider.manager.search(healthCheckQuery, { maxResults: 1 }),
        timeoutPromise,
      ]);

      // Health check success
      const responseTime = Date.now() - startTime;
      provider.stats.health = this.calculateHealth(provider.stats, responseTime);
      provider.recordSuccess();
    } catch {
      // Health check failure
      provider.stats.health = "unhealthy";
      provider.recordFailure();
    }
  }

  /**
   * Calculate health status
   */
  private calculateHealth(stats: ProviderWrapper["stats"], _responseTime: number): HealthStatus {
    // If open, mark as unhealthy
    if (stats.circuitBreakerState === "OPEN") {
      return "unhealthy";
    }

    // Calculate failure rate
    const totalRequests = stats.successfulRequests + stats.failedRequests;
    if (totalRequests === 0) {
      return "healthy"; // No requests, assume healthy
    }

    const failureRate = stats.failedRequests / totalRequests;

    // Judge based on failure rate
    if (failureRate >= this.config.degradationThreshold) {
      return "unhealthy";
    } else if (failureRate > 0) {
      return "degraded";
    } else {
      return "healthy";
    }
  }

  /**
   * Get health status of all providers
   */
  getHealthStatus(): Map<string, HealthStatus> {
    const status = new Map<string, HealthStatus>();

    this.providers.forEach((provider, name) => {
      status.set(name, provider.stats.health);
    });

    return status;
  }

  /**
   * Get list of healthy providers
   */
  getHealthyProviders(): ProviderWrapper[] {
    return Array.from(this.providers.values()).filter((p) => p.stats.health !== "unhealthy");
  }

  /**
   * Get configuration
   */
  getConfig(): HealthMonitorConfig {
    return { ...this.config };
  }
}
