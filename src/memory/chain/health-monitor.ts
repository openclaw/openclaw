/**
 * Chain Memory Backend - 健康监控
 *
 * 定期检查 provider 的健康状态
 *
 * @module health-monitor
 * @author Tutu
 * @date 2026-03-09
 */

import type { HealthStatus, ProviderWrapper } from "./types";

/**
 * 健康监控配置
 */
export interface HealthMonitorConfig {
  checkIntervalMs: number; // 健康检查间隔，默认 30000ms
  timeoutMs: number; // 检查超时，默认 5000ms
  degradationThreshold: number; // 降级阈值（失败率），默认 0.3
}

/**
 * 健康监控器
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
   * 注册 provider
   */
  registerProvider(provider: ProviderWrapper): void {
    this.providers.set(provider.config.name, provider);
  }

  /**
   * 注销 provider
   */
  unregisterProvider(name: string): void {
    this.providers.delete(name);
  }

  /**
   * 启动健康监控
   */
  start(): void {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.scheduleCheck();
  }

  /**
   * 停止健康监控
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
   * 调度下一次检查
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
   * 执行健康检查
   */
  private async performCheck(): Promise<void> {
    const checkPromises = Array.from(this.providers.values()).map(async (provider) => {
      try {
        await this.checkProvider(provider);
      } catch (error) {
        // 记录错误但不影响其他 provider 的检查
        console.error(`Health check failed for ${provider.config.name}:`, error);
      }
    });

    await Promise.allSettled(checkPromises);
  }

  /**
   * 检查单个 provider
   */
  private async checkProvider(provider: ProviderWrapper): Promise<void> {
    const startTime = Date.now();

    try {
      // 执行简单的搜索操作作为健康检查
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("Health check timeout")), this.config.timeoutMs);
      });

      await Promise.race([provider.manager.search("", { maxResults: 1 }), timeoutPromise]);

      // 健康检查成功
      const responseTime = Date.now() - startTime;
      provider.stats.health = this.calculateHealth(provider.stats, responseTime);
      provider.recordSuccess();
    } catch {
      // 健康检查失败
      provider.stats.health = "unhealthy";
      provider.recordFailure();
    }
  }

  /**
   * 计算健康状态
   */
  private calculateHealth(stats: ProviderWrapper["stats"], _responseTime: number): HealthStatus {
    // 如果熔断器打开，标记为 unhealthy
    if (stats.circuitBreakerState === "OPEN") {
      return "unhealthy";
    }

    // 计算失败率
    const totalRequests = stats.successfulRequests + stats.failedRequests;
    if (totalRequests === 0) {
      return "healthy"; // 没有请求，假设健康
    }

    const failureRate = stats.failedRequests / totalRequests;

    // 根据失败率判断
    if (failureRate >= this.config.degradationThreshold) {
      return "unhealthy";
    } else if (failureRate > 0) {
      return "degraded";
    } else {
      return "healthy";
    }
  }

  /**
   * 获取所有 provider 的健康状态
   */
  getHealthStatus(): Map<string, HealthStatus> {
    const status = new Map<string, HealthStatus>();

    this.providers.forEach((provider, name) => {
      status.set(name, provider.stats.health);
    });

    return status;
  }

  /**
   * 获取健康的 provider 列表
   */
  getHealthyProviders(): ProviderWrapper[] {
    return Array.from(this.providers.values()).filter((p) => p.stats.health !== "unhealthy");
  }

  /**
   * 获取配置
   */
  getConfig(): HealthMonitorConfig {
    return { ...this.config };
  }
}
