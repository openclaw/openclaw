/**
 * Chain Memory Backend - 类型定义
 *
 * @module types
 * @author Tutu
 * @date 2026-03-09
 */

import type { MemorySearchManager, MemorySearchResult } from "../../types";

/**
 * Provider 优先级
 */
export type ProviderPriority = "primary" | "secondary" | "fallback";

/**
 * 写入模式
 */
export type WriteMode = "sync" | "async";

/**
 * 熔断器状态
 */
export type CircuitBreakerState = "CLOSED" | "OPEN" | "HALF-OPEN";

/**
 * Provider 健康状态
 */
export type HealthStatus = "healthy" | "degraded" | "unhealthy";

/**
 * Provider 配置
 */
export interface ProviderConfig {
  name: string;
  priority: ProviderPriority;

  // backend 或 plugin 二选一
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
 * 全局配置
 */
export interface GlobalConfig {
  defaultTimeout: number;
  enableAsyncWrite: boolean;
  enableFallback: boolean;
  healthCheckInterval: number;
}

/**
 * Chain 配置
 */
export interface ChainConfig {
  providers: ProviderConfig[];
  global: GlobalConfig;
}

/**
 * Provider 统计信息
 */
export interface ProviderStats {
  name: string;
  priority: ProviderPriority;
  health: HealthStatus;

  // 熔断器状态
  circuitBreakerState: CircuitBreakerState;
  failureCount: number;

  // 性能统计
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  avgResponseTime: number;

  // 上次请求时间
  lastRequestTime?: number;
  lastFailureTime?: number;
}

/**
 * Provider 包装器
 */
export interface ProviderWrapper {
  config: ProviderConfig;
  manager: MemorySearchManager;
  stats: ProviderStats;

  // 熔断器
  circuitBreaker: {
    state: CircuitBreakerState;
    failures: number;
    lastFailureTime: number;
  };

  // 方法
  search(query: string, options?: unknown): Promise<MemorySearchResult[]>;
  isAvailable(): boolean;
  recordSuccess(): void;
  recordFailure(): void;
}

/**
 * 异步写入任务
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
 * 死信队列项
 */
export interface DeadLetterItem extends AsyncWriteTask {
  error: string;
  failedAt: number;
}

/**
 * Chain Manager 状态
 */
export interface ChainManagerStatus {
  backend: string;
  providers: ProviderStats[];

  // 异步队列状态
  asyncQueue: {
    pending: number;
    processing: number;
    deadLetter: number;
  };

  // 全局配置
  global: GlobalConfig;
}

/**
 * Chain Manager 选项
 */
export interface ChainManagerOptions {
  config: ChainConfig;
  getBackendManager: (backend: string, config?: unknown) => MemorySearchManager;
  getPluginManager?: (plugin: string, config?: unknown) => MemorySearchManager; // 新增：支持 plugin
}
