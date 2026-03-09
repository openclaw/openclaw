/**
 * Chain Memory Backend - Export
 *
 * @module chain
 * @author Tutu
 * @date 2026-03-09
 */

export { ChainMemoryManager } from "./manager";
export { ProviderWrapper } from "./wrapper";
export { AsyncWriteQueue } from "./async-queue";
export { CircuitBreaker } from "./circuit-breaker";
export { HealthMonitor } from "./health-monitor";

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
} from "./types";
