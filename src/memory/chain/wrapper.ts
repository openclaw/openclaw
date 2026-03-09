/**
 * Chain Memory Backend - Provider 包装器
 *
 * 包装单个 provider，提供超时、重试、熔断器功能
 *
 * @module wrapper
 * @author Tutu
 * @date 2026-03-09
 */

import type { MemorySearchManager, MemorySearchResult } from "../../types";
import { CircuitBreaker } from "./circuit-breaker";
import type {
  ProviderConfig,
  ProviderStats,
  ProviderWrapper as IProviderWrapper,
  CircuitBreakerState,
} from "./types";

/**
 * Provider 包装器实现
 */
export class ProviderWrapper implements IProviderWrapper {
  config: ProviderConfig;
  manager: MemorySearchManager;
  stats: ProviderStats;
  circuitBreaker: {
    state: CircuitBreakerState;
    failures: number;
    lastFailureTime: number;
  };

  private circuitBreakerInstance: CircuitBreaker;

  constructor(config: ProviderConfig, manager: MemorySearchManager) {
    this.config = config;
    this.manager = manager;

    // 初始化熔断器
    this.circuitBreakerInstance = new CircuitBreaker({
      failureThreshold: config.circuitBreaker?.failureThreshold ?? 5,
      resetTimeoutMs: config.circuitBreaker?.resetTimeoutMs ?? 60000,
    });

    // 初始化统计信息
    this.stats = {
      name: config.name,
      priority: config.priority,
      health: "healthy",
      circuitBreakerState: "CLOSED",
      failureCount: 0,
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      avgResponseTime: 0,
    };

    // 初始化熔断器状态
    this.circuitBreaker = {
      state: "CLOSED",
      failures: 0,
      lastFailureTime: 0,
    };
  }

  /**
   * 执行搜索
   */
  async search(query: string, options?: unknown): Promise<MemorySearchResult[]> {
    const timeout = this.config.timeout?.search ?? 5000;

    return this.executeWithTimeout(() => this.manager.search(query, options), timeout, "search");
  }

  /**
   * 检查是否可用
   */
  isAvailable(): boolean {
    // 检查是否启用
    if (this.config.enabled === false) {
      return false;
    }

    // 检查熔断器
    return !this.circuitBreakerInstance.isOpen();
  }

  /**
   * 记录成功
   */
  recordSuccess(): void {
    this.circuitBreakerInstance.recordSuccess();
    this.updateCircuitBreakerState();

    this.stats.successfulRequests++;
    this.stats.totalRequests++;
  }

  /**
   * 记录失败
   */
  recordFailure(): void {
    this.circuitBreakerInstance.recordFailure();
    this.updateCircuitBreakerState();

    this.stats.failedRequests++;
    this.stats.totalRequests++;
    this.stats.failureCount = this.circuitBreakerInstance.getFailureCount();
    this.stats.lastFailureTime = Date.now();
  }

  /**
   * 带超时和重试的执行
   */
  private async executeWithTimeout<T>(
    operation: () => Promise<T>,
    timeoutMs: number,
    operationName: string,
  ): Promise<T> {
    // 检查熔断器
    if (this.circuitBreakerInstance.isOpen()) {
      throw new Error(`Circuit breaker is OPEN for ${this.config.name}`);
    }

    const startTime = Date.now();
    const maxAttempts = this.config.retry?.maxAttempts ?? 3;
    const backoffMs = this.config.retry?.backoffMs ?? 1000;

    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // 创建超时 promise
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(new Error(`${operationName} timeout after ${timeoutMs}ms`));
          }, timeoutMs);
        });

        // 执行操作
        const result = await Promise.race([operation(), timeoutPromise]);

        // 成功
        const responseTime = Date.now() - startTime;
        this.updateResponseTime(responseTime);
        this.recordSuccess();

        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // 如果不是最后一次尝试，等待后重试
        if (attempt < maxAttempts) {
          await this.sleep(backoffMs * attempt);
        }
      }
    }

    // 所有尝试都失败
    this.recordFailure();
    throw lastError || new Error(`${operationName} failed after ${maxAttempts} attempts`);
  }

  /**
   * 更新熔断器状态
   */
  private updateCircuitBreakerState(): void {
    const state = this.circuitBreakerInstance.getState();
    this.stats.circuitBreakerState = state;
    this.circuitBreaker.state = state;
    this.circuitBreaker.failures = this.circuitBreakerInstance.getFailureCount();

    if (state === "OPEN") {
      this.circuitBreaker.lastFailureTime = Date.now();
    }
  }

  /**
   * 更新平均响应时间
   */
  private updateResponseTime(responseTime: number): void {
    // 使用指数移动平均
    const alpha = 0.1;
    this.stats.avgResponseTime =
      this.stats.avgResponseTime === 0
        ? responseTime
        : alpha * responseTime + (1 - alpha) * this.stats.avgResponseTime;
  }

  /**
   * 睡眠
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * 获取统计信息
   */
  getStats(): ProviderStats {
    return { ...this.stats };
  }

  /**
   * 重置熔断器
   */
  resetCircuitBreaker(): void {
    this.circuitBreakerInstance.reset();
    this.updateCircuitBreakerState();
    this.stats.failureCount = 0;
  }
}
