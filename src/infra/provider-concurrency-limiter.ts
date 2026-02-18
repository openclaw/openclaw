/**
 * Provider Concurrency Limiter
 *
 * Prevents resource contention when multiple agent sessions compete for the same LLM endpoint.
 * Especially critical for local LLMs (llamacpp, vllm) that struggle with concurrent requests.
 *
 * Features:
 * - Per-endpoint queuing with configurable concurrency limits
 * - Priority support for time-sensitive agents (e.g., heartbeat)
 * - Timeout handling for stuck requests
 * - Metrics for queue depth and wait times
 */

import { logInfo, logWarn } from "../logger.js";

export type ProviderConcurrencyConfig = {
  /**
   * Maximum concurrent requests allowed for this provider/endpoint.
   * Default: Infinity (no limit)
   */
  maxConcurrent?: number;

  /**
   * Maximum time (ms) a request can wait in the queue before timing out.
   * Default: 30000 (30 seconds)
   */
  queueTimeoutMs?: number;

  /**
   * Whether to enable verbose logging for this provider.
   * Default: false
   */
  verbose?: boolean;
};

export type ProviderConcurrencyLimits = {
  /**
   * Default config for all providers
   */
  default?: ProviderConcurrencyConfig;

  /**
   * Provider-specific overrides by provider name or endpoint URL
   * Examples:
   *   - "llamacpp" or "localhost:8000"
   *   - "vllm" or "localhost:5001"
   */
  providers?: Record<string, ProviderConcurrencyConfig>;
};

type QueuedRequest = {
  providerId: string;
  priority: number;
  enqueueTime: number;
  resolve: () => void;
  reject: (err: Error) => void;
  timeoutHandle: NodeJS.Timeout | null;
};

type ProviderStats = {
  active: number;
  queued: number;
  totalWaitMs: number;
  requestCount: number;
};

/**
 * Global registry of provider concurrency limiters
 */
class ProviderConcurrencyLimiterRegistry {
  private activeRequests: Map<string, Set<symbol>> = new Map();
  private requestQueues: Map<string, QueuedRequest[]> = new Map();
  private config: ProviderConcurrencyLimits = {};

  configure(config: ProviderConcurrencyLimits): void {
    this.config = config;
  }

  getConfig(providerId: string): ProviderConcurrencyConfig {
    // Check provider-specific config first
    const providerConfig = this.config.providers?.[providerId];
    if (providerConfig) {
      return {
        maxConcurrent:
          providerConfig.maxConcurrent ?? this.config.default?.maxConcurrent ?? Infinity,
        queueTimeoutMs:
          providerConfig.queueTimeoutMs ?? this.config.default?.queueTimeoutMs ?? 30000,
        verbose: providerConfig.verbose ?? this.config.default?.verbose ?? false,
      };
    }

    // Fall back to default config
    return {
      maxConcurrent: this.config.default?.maxConcurrent ?? Infinity,
      queueTimeoutMs: this.config.default?.queueTimeoutMs ?? 30000,
      verbose: this.config.default?.verbose ?? false,
    };
  }

  /**
   * Acquire a slot for the provider. Returns a release token.
   * May queue the request if the concurrency limit is reached.
   */
  async acquire(
    providerId: string,
    options?: { priority?: number; timeoutMs?: number },
  ): Promise<symbol> {
    const config = this.getConfig(providerId);
    const priority = options?.priority ?? 0;
    const timeoutMs = options?.timeoutMs ?? config.queueTimeoutMs;

    const active = this.activeRequests.get(providerId);
    const activeCount = active?.size ?? 0;

    // If under the limit, acquire immediately
    if (activeCount < config.maxConcurrent) {
      const token = Symbol(`provider:${providerId}:${Date.now()}`);
      if (!active) {
        this.activeRequests.set(providerId, new Set([token]));
      } else {
        active.add(token);
      }

      if (config.verbose) {
        logInfo(
          `[provider-concurrency] ${providerId}: acquired immediately (${activeCount + 1}/${config.maxConcurrent})`,
        );
      }

      return token;
    }

    // Otherwise, queue the request
    if (config.verbose) {
      logInfo(
        `[provider-concurrency] ${providerId}: queuing request (${activeCount}/${config.maxConcurrent} active)`,
      );
    }

    return new Promise<symbol>((resolve, reject) => {
      const enqueueTime = Date.now();

      const timeoutHandle = setTimeout(() => {
        this.removeFromQueue(providerId, queuedRequest);
        reject(new Error(`Provider ${providerId} request timed out after ${timeoutMs}ms in queue`));
      }, timeoutMs);

      const queuedRequest: QueuedRequest = {
        providerId,
        priority,
        enqueueTime,
        timeoutHandle,
        resolve: () => {
          const token = Symbol(`provider:${providerId}:${Date.now()}`);
          const active = this.activeRequests.get(providerId);
          if (!active) {
            this.activeRequests.set(providerId, new Set([token]));
          } else {
            active.add(token);
          }

          const waitMs = Date.now() - enqueueTime;
          if (config.verbose) {
            logInfo(`[provider-concurrency] ${providerId}: dequeued after ${waitMs}ms`);
          }

          resolve(token);
        },
        reject,
      };

      const queue = this.requestQueues.get(providerId);
      if (!queue) {
        this.requestQueues.set(providerId, [queuedRequest]);
      } else {
        // Insert in priority order (higher priority first)
        const insertIndex = queue.findIndex((req) => req.priority < priority);
        if (insertIndex === -1) {
          queue.push(queuedRequest);
        } else {
          queue.splice(insertIndex, 0, queuedRequest);
        }
      }
    });
  }

  /**
   * Release a previously acquired slot.
   */
  release(providerId: string, token: symbol): void {
    const active = this.activeRequests.get(providerId);
    if (!active || !active.has(token)) {
      logWarn(`[provider-concurrency] ${providerId}: attempted to release unknown token`);
      return;
    }

    active.delete(token);

    const config = this.getConfig(providerId);
    if (config.verbose) {
      logInfo(
        `[provider-concurrency] ${providerId}: released (${active.size}/${config.maxConcurrent})`,
      );
    }

    // Process next queued request
    this.processQueue(providerId);
  }

  private processQueue(providerId: string): void {
    const queue = this.requestQueues.get(providerId);
    if (!queue || queue.length === 0) {
      return;
    }

    const config = this.getConfig(providerId);
    const active = this.activeRequests.get(providerId);
    const activeCount = active?.size ?? 0;

    if (activeCount >= config.maxConcurrent) {
      return; // Still at limit
    }

    // Dequeue the highest priority request
    const next = queue.shift();
    if (!next) {
      return;
    }

    // Clear timeout
    if (next.timeoutHandle) {
      clearTimeout(next.timeoutHandle);
    }

    // Resolve the promise (which will add to active set)
    next.resolve();

    // Continue processing queue if there's room
    if (queue.length > 0 && activeCount + 1 < config.maxConcurrent) {
      this.processQueue(providerId);
    }
  }

  private removeFromQueue(providerId: string, request: QueuedRequest): void {
    const queue = this.requestQueues.get(providerId);
    if (!queue) {
      return;
    }

    const index = queue.indexOf(request);
    if (index !== -1) {
      queue.splice(index, 1);
    }
  }

  /**
   * Get current stats for a provider
   */
  getStats(providerId: string): ProviderStats {
    const active = this.activeRequests.get(providerId);
    const queue = this.requestQueues.get(providerId);

    const totalWaitMs = queue?.reduce((sum, req) => sum + (Date.now() - req.enqueueTime), 0) ?? 0;

    return {
      active: active?.size ?? 0,
      queued: queue?.length ?? 0,
      totalWaitMs,
      requestCount: (active?.size ?? 0) + (queue?.length ?? 0),
    };
  }

  /**
   * Clear all queues and active requests (for testing)
   */
  reset(): void {
    // Clear all timeouts
    for (const queue of this.requestQueues.values()) {
      for (const req of queue) {
        if (req.timeoutHandle) {
          clearTimeout(req.timeoutHandle);
        }
      }
    }

    this.activeRequests.clear();
    this.requestQueues.clear();
  }
}

/**
 * Global singleton instance
 */
export const providerConcurrencyLimiter = new ProviderConcurrencyLimiterRegistry();

/**
 * Helper to normalize provider ID from model string
 * Examples:
 *   - "llamacpp/qwen" -> "llamacpp"
 *   - "localhost:8000/v1" -> "localhost:8000"
 *   - "anthropic/claude-3" -> "anthropic"
 */
export function normalizeProviderId(model: string, baseUrl?: string): string {
  if (baseUrl) {
    // Extract host from base URL
    try {
      const url = new URL(baseUrl);
      return url.host; // e.g., "localhost:8000"
    } catch {
      return baseUrl;
    }
  }

  // Extract provider from model string
  const parts = model.split("/");
  return parts[0] ?? model;
}

/**
 * Execute a function with provider concurrency limiting
 */
export async function withProviderConcurrency<T>(
  providerId: string,
  fn: () => Promise<T>,
  options?: { priority?: number; timeoutMs?: number },
): Promise<T> {
  const token = await providerConcurrencyLimiter.acquire(providerId, options);
  try {
    return await fn();
  } finally {
    providerConcurrencyLimiter.release(providerId, token);
  }
}
