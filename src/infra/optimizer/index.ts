/**
 * OpenClaw Optimizer Module
 * Performance optimization components for OpenClaw
 *
 * This module provides:
 * - Connection Pooling: Efficient HTTP connection management
 * - Message Queue: Async message processing with retry logic
 * - Performance Monitoring: System metrics and health tracking
 * - LRU Cache: High-performance Least Recently Used cache
 * - Memoization: Function result caching with TTL support
 *
 * Note: LLM caching is handled by Provider-native Prompt Caching
 * via cacheRetention and sessionId options in the stream API.
 */

export {
  ConnectionPoolManager,
  getConnectionPool,
  closeConnectionPool,
  type ConnectionPoolOptions,
  type ConnectionPoolMetrics,
} from "./connection-pool.js";

export {
  MessageQueue,
  getMessageQueue,
  clearMessageQueue,
  type MessageQueueOptions,
  type QueueMessage,
  type QueueStats,
} from "./message-queue.js";

export {
  PerformanceMonitor,
  getPerformanceMonitor,
  startPerformanceMonitor,
  stopPerformanceMonitor,
  type PerformanceMonitorOptions,
  type PerformanceStats,
} from "./performance-monitor.js";

export { LRUCache, createLRUCache } from "../lru-cache.js";
export { memoize, memoizeAsync } from "../memoize.js";
export { shallowClone, shallowCloneMap, shallowCloneSet, cloneWithFreeze } from "../clone.js";

import { ConnectionPoolManager, getConnectionPool } from "./connection-pool.js";
import { MessageQueue, getMessageQueue } from "./message-queue.js";
import { PerformanceMonitor, startPerformanceMonitor } from "./performance-monitor.js";

export interface OptimizerConfig {
  pool?: {
    maxConnectionsPerHost?: number;
    keepAlive?: boolean;
  };
  queue?: {
    concurrency?: number;
    maxRetries?: number;
  };
  monitor?: {
    enabled?: boolean;
    sampleInterval?: number;
  };
}

export interface OptimizerInstance {
  pool: ConnectionPoolManager;
  queue: MessageQueue;
  monitor: PerformanceMonitor;
  getStats: () => {
    pool: ReturnType<ConnectionPoolManager["getMetrics"]>;
    queue: ReturnType<MessageQueue["getStats"]>;
    monitor: ReturnType<PerformanceMonitor["getStats"]>;
  };
  shutdown: () => Promise<void>;
}

let globalOptimizer: OptimizerInstance | null = null;

export function initializeOptimizer(config: OptimizerConfig = {}): OptimizerInstance {
  const pool = getConnectionPool({
    maxConnectionsPerHost: config.pool?.maxConnectionsPerHost ?? 50,
    keepAlive: config.pool?.keepAlive ?? true,
  });

  const queue = getMessageQueue({
    concurrency: config.queue?.concurrency ?? 10,
    maxRetries: config.queue?.maxRetries ?? 3,
  });

  const monitor = startPerformanceMonitor({
    sampleInterval: config.monitor?.sampleInterval ?? 5000,
  });

  const instance: OptimizerInstance = {
    pool,
    queue,
    monitor,
    getStats() {
      return {
        pool: pool.getMetrics(),
        queue: queue.getStats(),
        monitor: monitor.getStats(),
      };
    },
    async shutdown() {
      monitor.stop();
      queue.pause();
      await pool.close();
    },
  };

  globalOptimizer = instance;
  return instance;
}

export function getOptimizer(): OptimizerInstance | null {
  return globalOptimizer;
}

export async function shutdownOptimizer(): Promise<void> {
  if (globalOptimizer) {
    await globalOptimizer.shutdown();
    globalOptimizer = null;
  }
}
