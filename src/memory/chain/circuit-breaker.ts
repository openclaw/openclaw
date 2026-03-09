/**
 * Chain Memory Backend - 熔断器
 *
 * 实现熔断器模式，防止级联故障
 *
 * 状态转换：
 * CLOSED (正常) → OPEN (熔断) → HALF-OPEN (试探) → CLOSED
 *
 * @module circuit-breaker
 * @author Tutu
 * @date 2026-03-09
 */

import type { CircuitBreakerState } from "./types";

/**
 * 熔断器配置
 */
export interface CircuitBreakerConfig {
  failureThreshold: number; // 失败阈值，默认 5
  resetTimeoutMs: number; // 重置超时，默认 60000ms
}

/**
 * 熔断器实现
 */
export class CircuitBreaker {
  private state: CircuitBreakerState = "CLOSED";
  private failures: number = 0;
  private lastFailureTime: number = 0;
  private config: CircuitBreakerConfig;

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = {
      failureThreshold: config.failureThreshold ?? 5,
      resetTimeoutMs: config.resetTimeoutMs ?? 60000,
    };
  }

  /**
   * 记录成功
   *
   * 成功后重置失败计数，状态变为 CLOSED
   */
  recordSuccess(): void {
    this.failures = 0;
    this.state = "CLOSED";
  }

  /**
   * 记录失败
   *
   * 失败后增加失败计数，达到阈值后状态变为 OPEN
   */
  recordFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();

    if (this.failures >= this.config.failureThreshold) {
      this.state = "OPEN";
    }
  }

  /**
   * 检查熔断器是否打开（是否应该拒绝请求）
   *
   * @returns true - 应该拒绝请求（熔断器打开）
   *          false - 可以尝试请求
   */
  isOpen(): boolean {
    if (this.state === "CLOSED") {
      return false;
    }

    if (this.state === "OPEN") {
      // 检查是否应该进入 HALF-OPEN 状态
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.config.resetTimeoutMs) {
        this.state = "HALF-OPEN";
        return false; // 允许一个试探请求
      }
      return true; // 仍然打开
    }

    // HALF-OPEN 状态，允许一个试探请求
    return false;
  }

  /**
   * 获取当前状态
   */
  getState(): CircuitBreakerState {
    return this.state;
  }

  /**
   * 获取失败计数
   */
  getFailureCount(): number {
    return this.failures;
  }

  /**
   * 手动重置熔断器
   */
  reset(): void {
    this.failures = 0;
    this.state = "CLOSED";
    this.lastFailureTime = 0;
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    state: CircuitBreakerState;
    failures: number;
    lastFailureTime: number;
    config: CircuitBreakerConfig;
  } {
    return {
      state: this.state,
      failures: this.failures,
      lastFailureTime: this.lastFailureTime,
      config: this.config,
    };
  }
}
