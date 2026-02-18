/**
 * OpenClaw Optimizer Module
 * Performance optimization components for OpenClaw
 *
 * This module provides:
 * - LLM Response Caching: Reduces API calls and latency
 * - Connection Pooling: Efficient HTTP connection management
 * - Message Queue: Async message processing with retry logic
 * - Performance Monitoring: System metrics and health tracking
 */

export {
  LLMResponseCache,
  getLLMCache,
  clearLLMCache,
  type LLMCacheOptions,
  type CacheEntry,
  type CacheStats,
} from "./llm-cache.js";

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

export {
  createStreamCacheWrapper,
  getStreamCacheWrapper,
  type StreamCacheConfig,
  type StreamCacheWrapper,
} from "./stream-cache.js";

import { ConnectionPoolManager, getConnectionPool } from "./connection-pool.js";
import { LLMResponseCache, getLLMCache } from "./llm-cache.js";
import { MessageQueue, getMessageQueue } from "./message-queue.js";
import { PerformanceMonitor, startPerformanceMonitor } from "./performance-monitor.js";
import {
  getStreamCacheWrapper,
  type StreamCacheStats,
  type StreamCacheWrapper,
} from "./stream-cache.js";

export interface OptimizerConfig {
  cache?: {
    enabled?: boolean;
    ttl?: number;
    maxSize?: number;
    skipCacheForTools?: boolean;
  };
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
  cache: LLMResponseCache;
  pool: ConnectionPoolManager;
  queue: MessageQueue;
  monitor: PerformanceMonitor;
  streamCache: StreamCacheWrapper;
  getStats: () => {
    cache: StreamCacheStats;
    pool: ReturnType<ConnectionPoolManager["getMetrics"]>;
    queue: ReturnType<MessageQueue["getStats"]>;
    monitor: ReturnType<PerformanceMonitor["getStats"]>;
  };
  shutdown: () => Promise<void>;
}

let globalOptimizer: OptimizerInstance | null = null;

export function initializeOptimizer(config: OptimizerConfig = {}): OptimizerInstance {
  const cache = getLLMCache({
    enabled: config.cache?.enabled ?? true,
    ttl: config.cache?.ttl ?? 3600000,
    maxSize: config.cache?.maxSize ?? 1000,
  });

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

  const streamCache = getStreamCacheWrapper({
    enabled: config.cache?.enabled ?? true,
    ttl: config.cache?.ttl ?? 3600000,
    maxSize: config.cache?.maxSize ?? 1000,
    skipCacheForTools: config.cache?.skipCacheForTools ?? true,
  });

  const instance: OptimizerInstance = {
    cache,
    pool,
    queue,
    monitor,
    streamCache,
    getStats() {
      return {
        cache: streamCache.getStats(),
        pool: pool.getMetrics(),
        queue: queue.getStats(),
        monitor: monitor.getStats(),
      };
    },
    async shutdown() {
      monitor.stop();
      queue.pause();
      streamCache.clear();
      await pool.close();
      cache.clear();
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
