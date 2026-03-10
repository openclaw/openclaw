/**
 * Chain Memory Backend - Export
 *
 * @module chain
 * @author Tutu
 * @date 2026-03-09
 */

export { ChainMemoryManager } from "./manager.js";
export { ProviderWrapper } from "./wrapper.js";
export { AsyncWriteQueue } from "./async-queue.js";
export { CircuitBreaker } from "./circuit-breaker.js";
export { HealthMonitor } from "./health-monitor.js";

export type {
  ProviderConfig,
  GlobalConfig,
  ChainConfig,
  ProviderStats,
  ProviderWrapper as IProviderWrapper,
  AsyncWriteTask,
  DeadLetterItem,
  ChainManagerStatus,
  ChainManagerOptions,
  ProviderPriority,
  WriteMode,
  CircuitBreakerState,
  HealthStatus,
} from "./types.js";
