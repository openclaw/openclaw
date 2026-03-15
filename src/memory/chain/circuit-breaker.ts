/**
 * Chain Memory Backend - Circuit Breaker
 *
 * Implement circuit breaker pattern to prevent cascading failures
 *
 * State transitions：
 * CLOSED (Normal - CLOSED, Circuit open - OPEN, Probe - HALF-OPEN) → CLOSED
 *
 * @module circuit-breaker
 * @author Tutu
 * @date 2026-03-09
 */

import type { CircuitBreakerState } from "./types.js";

/**
 * Circuit Breaker Configuration
 */
export interface CircuitBreakerConfig {
  failureThreshold: number; // Failure threshold, default 5
  resetTimeoutMs: number; // Reset timeout, default 60000ms
}

/**
 * Circuit Breaker Implementation
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
   * Record Success
   *
   * Reset failure count and state after timeout CLOSED
   */
  recordSuccess(): void {
    this.failures = 0;
    this.state = "CLOSED";
  }

  /**
   * Record Failure
   *
   * After failure, increment failure count. State becomes OPEN when threshold is reached
   */
  recordFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();

    if (this.failures >= this.config.failureThreshold) {
      this.state = "OPEN";
    }
  }

  /**
   * Check if circuit is open and if request should be rejected）
   *
   * @returns true - Should reject request, circuit is open）
   *          false - Can try request
   */
  isOpen(): boolean {
    if (this.state === "CLOSED") {
      return false;
    }

    if (this.state === "OPEN") {
      // Check if should enter HALF-OPEN state
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= this.config.resetTimeoutMs) {
        this.state = "HALF-OPEN";
        return false; // Allow one probe request
      }
      return true; // Still open
    }

    // HALF-OPEN state, allow one probe request
    return false;
  }

  /**
   * Get current state
   */
  getState(): CircuitBreakerState {
    return this.state;
  }

  /**
   * Get failure count
   */
  getFailureCount(): number {
    return this.failures;
  }

  /**
   * Manual resetCircuit Breaker
   */
  reset(): void {
    this.failures = 0;
    this.state = "CLOSED";
    this.lastFailureTime = 0;
  }

  /**
   * Get statistics
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
