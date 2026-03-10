/**
 * Chain Memory Backend - Type definitions
 *
 * @module types
 * @author Tutu
 * @date 2026-03-09
 */

import type { MemorySearchManager, MemorySearchResult } from "../types.js";

/**
 * Provider Priority
 */
export type ProviderPriority = "primary" | "secondary" | "fallback";

/**
 * Write mode
 */
export type WriteMode = "sync" | "async";

/**
 * Circuit BreakerStatus
 */
export type CircuitBreakerState = "CLOSED" | "OPEN" | "HALF-OPEN";

/**
 * Provider Health status
 */
export type HealthStatus = "healthy" | "degraded" | "unhealthy";

/**
 * Provider configuration
 */
export interface ProviderConfig {
  name: string;
  priority: ProviderPriority;

  // Either backend or plugin (mutually exclusive)
  backend?: string;
  plugin?: string;

  enabled?: boolean;

  timeout?: {
    add?: number;
    search?: number;
    update?: number;
    delete?: number;
  };

  retry?: {
    maxAttempts?: number;
    backoffMs?: number;
  };

  circuitBreaker?: {
    failureThreshold?: number;
    resetTimeoutMs?: number;
  };

  writeMode?: WriteMode;

  [key: string]: unknown;
}

/**
 * Global configuration
 */
export interface GlobalConfig {
  defaultTimeout: number;
  enableAsyncWrite: boolean;
  enableFallback: boolean;
  healthCheckInterval: number;
}

/**
 * Chain Configuration
 */
export interface ChainConfig {
  providers: ProviderConfig[];
  global: GlobalConfig;
}

/**
 * Provider Statistics
 */
export interface ProviderStats {
  name: string;
  priority: ProviderPriority;
  health: HealthStatus;

  // Circuit BreakerStatus
  circuitBreakerState: CircuitBreakerState;
  failureCount: number;

  // Performance statistics
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  avgResponseTime: number;

  // Last request time
  lastRequestTime?: number;
  lastFailureTime?: number;
}

/**
 * Provider Wrapper
 */
export interface ProviderWrapper {
  config: ProviderConfig;
  manager: MemorySearchManager;
  stats: ProviderStats;

  // Circuit Breaker
  circuitBreaker: {
    state: CircuitBreakerState;
    failures: number;
    lastFailureTime: number;
  };

  // Method
  search(query: string, options?: unknown): Promise<MemorySearchResult[]>;
  isAvailable(): boolean;
  recordSuccess(): void;
  recordFailure(): void;
}

/**
 * Async write task
 */
export interface AsyncWriteTask {
  id: string;
  providerName: string;
  operation: "add" | "update" | "delete";
  data: unknown;
  timestamp: number;
  attempts: number;
  maxAttempts: number;
}

/**
 * Dead letter queue item
 */
export interface DeadLetterItem extends AsyncWriteTask {
  error: string;
  failedAt: number;
}

/**
 * Chain manager status
 */
export interface ChainManagerStatus {
  backend: string;
  providers: ProviderStats[];

  // Async queue status
  asyncQueue: {
    pending: number;
    processing: number;
    deadLetter: number;
  };

  // Global configuration
  global: GlobalConfig;
}

/**
 * Chain Manager Options
 */
export interface ChainManagerOptions {
  config: ChainConfig;
  // Async factory for builtin/qmd backends
  getBackendManager: (backend: string, config?: unknown) => Promise<MemorySearchManager>;
  // Async factory for plugins
  getPluginManager?: (plugin: string, config?: unknown) => Promise<MemorySearchManager>;
}
