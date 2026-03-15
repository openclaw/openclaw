/**
 * Chain Memory Backend - Export
 *
 * @module chain
 * @author Tutu
 * @date 2026-03-09
 */

export { ChainMemoryManager } from "./manager.js";
export { ProviderWrapper } from "./wrapper.js";
export { CircuitBreaker } from "./circuit-breaker.js";
export { HealthMonitor } from "./health-monitor.js";

export type {
  ProviderConfig,
  GlobalConfig,
  ChainConfig,
  ProviderStats,
  ProviderWrapper as IProviderWrapper,
  ChainManagerStatus,
  ChainManagerOptions,
  ProviderPriority,
  CircuitBreakerState,
  HealthStatus,
} from "./types.js";
