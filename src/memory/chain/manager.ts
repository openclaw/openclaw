/**
 * Chain Memory Backend - Chain Memory Manager
 *
 * Coordinate multiple providers with fault isolation and degradation
 *
 * @module manager
 * @author Tutu
 * @date 2026-03-09
 */

import { validateChainConfig } from "../../config-validator";
import type { MemorySearchManager, MemorySearchResult } from "../../types";
import { AsyncWriteQueue } from "./async-queue";
import { HealthMonitor } from "./health-monitor";
import type {
  ChainConfig,
  ProviderWrapper,
  ChainManagerStatus,
  ChainManagerOptions,
} from "./types";
import { ProviderWrapper as ProviderWrapperClass } from "./wrapper";

/**
 * Chain Memory Manager
 *
 * Implement multi-provider coordination with fault isolation and degradation
 */
export class ChainMemoryManager implements MemorySearchManager {
  private config: ChainConfig;
  private providers: Map<string, ProviderWrapperClass> = new Map();
  private primary?: ProviderWrapperClass;
  private secondary: ProviderWrapperClass[] = [];
  private fallback?: ProviderWrapperClass;
  private asyncQueue: AsyncWriteQueue;
  private healthMonitor: HealthMonitor;
  private getBackendManager: (backend: string, config?: unknown) => MemorySearchManager;
  private getPluginManager?: (plugin: string, config?: unknown) => MemorySearchManager; // Newly added

  constructor(options: ChainManagerOptions) {
    // Validate configuration
    const validated = validateChainConfig(options.config);
    this.config = {
      providers: validated.providers,
      global: validated.global,
    };

    this.getBackendManager = options.getBackendManager;
    this.getPluginManager = options.getPluginManager; // Newly added

    // Initialize async queue
    this.asyncQueue = new AsyncWriteQueue({
      maxConcurrent: 10,
      retryDelayMs: 1000,
      maxRetries: 3,
    });

    // SetQueue Processor
    // TODO: Async write queue needs redesign
    // The current MemorySearchManager interface doesn't have add/update/delete methods
    // We need to either:
    // 1. Extend the interface with write methods
    // 2. Use sync() with appropriate parameters
    // 3. Implement a different approach for dual-write
    this.asyncQueue.setProcessor(async (task) => {
      const provider = this.providers.get(task.providerName);
      if (!provider) {
        throw new Error(`Provider ${task.providerName} not found`);
      }

      // TODO: Implement proper write operations
      // Currently disabled to prevent runtime errors
      log.warn(
        `Async write operation '${task.operation}' for provider '${task.providerName}' is not yet implemented. ` +
          `Task ID: ${task.id}`,
      );

      // Placeholder: no actual operation performed
      // This prevents the queue from crashing while we redesign the async write feature
    });

    // InitializeHealth Monitor
    this.healthMonitor = new HealthMonitor({
      checkIntervalMs: this.config.global.healthCheckInterval,
      timeoutMs: this.config.global.defaultTimeout,
    });

    // Initialize providers
    this.initializeProviders();

    // StartHealth Monitor
    this.healthMonitor.start();
  }

  /**
   * Initialize providers
   */
  private initializeProviders(): void {
    for (const providerConfig of this.config.providers) {
      // Skip disabled provider
      if (providerConfig.enabled === false) {
        continue;
      }

      // Get underlying manager, support backend or plugin plugin）
      let manager: MemorySearchManager;

      if (providerConfig.backend) {
        // Use backend
        manager = this.getBackendManager(providerConfig.backend, providerConfig);
      } else if (providerConfig.plugin) {
        // Use plugin
        if (!this.getPluginManager) {
          throw new Error(
            `getPluginManager not provided but plugin '${providerConfig.plugin}' specified for provider '${providerConfig.name}'`,
          );
        }
        manager = this.getPluginManager(providerConfig.plugin, providerConfig);
      } else {
        // Should not happen (validated by config-validator)
        throw new Error(
          `Either backend or plugin must be specified for provider '${providerConfig.name}'`,
        );
      }

      // Create wrapper
      const wrapper = new ProviderWrapperClass(providerConfig, manager);

      // Register to map
      this.providers.set(providerConfig.name, wrapper);

      // Register toHealth Monitor
      this.healthMonitor.registerProvider(wrapper);

      // Classify by priority
      if (providerConfig.priority === "primary") {
        this.primary = wrapper;
      } else if (providerConfig.priority === "secondary") {
        this.secondary.push(wrapper);
      } else if (providerConfig.priority === "fallback") {
        this.fallback = wrapper;
      }
    }
  }

  /**
   * Search memory
   */
  async search(
    query: string,
    options?: { maxResults?: number; minScore?: number; sessionKey?: string },
  ): Promise<MemorySearchResult[]> {
    // Try primary
    if (this.primary && this.primary.isAvailable()) {
      try {
        return await this.primary.search(query, options);
      } catch (error) {
        // Primary Failure，Try fallback
        console.error(`Primary search failed:`, error);
      }
    }

    // Try secondary
    for (const provider of this.secondary) {
      if (provider.isAvailable()) {
        try {
          return await provider.search(query, options);
        } catch (error) {
          console.error(`Secondary ${provider.config.name} search failed:`, error);
        }
      }
    }

    // Try fallback
    if (this.config.global.enableFallback && this.fallback && this.fallback.isAvailable()) {
      try {
        return await this.fallback.search(query, options);
      } catch (error) {
        console.error(`Fallback search failed:`, error);
      }
    }

    // All providers returned empty
    return [];
  }

  /**
   * Read file
   */
  async readFile(options: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ path: string; text: string }> {
    // Try primary
    if (this.primary && this.primary.isAvailable()) {
      try {
        return await this.primary.manager.readFile(options);
      } catch (error) {
        console.error(`Primary readFile failed:`, error);
      }
    }

    // Try fallback
    if (this.config.global.enableFallback && this.fallback && this.fallback.isAvailable()) {
      try {
        return await this.fallback.manager.readFile(options);
      } catch (error) {
        console.error(`Fallback readFile failed:`, error);
      }
    }

    throw new Error("No available provider for readFile");
  }

  /**
   * Get status
   */
  status(): {
    backend: string;
    provider: string;
    model: string;
    fallback?: string;
    custom?: unknown;
  } {
    const providerStats = Array.from(this.providers.values()).map((p) => p.getStats());

    const queueStatus = this.asyncQueue.getStatus();

    return {
      backend: "chain",
      provider: "chain",
      model: "multi-provider",
      fallback: this.fallback?.config.name,
      custom: {
        providers: providerStats,
        queue: queueStatus,
        health: this.healthMonitor.getHealthStatus(),
      },
    };
  }

  /**
   * Probe embedding availability
   * Delegate to primary provider
   */
  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    if (!this.primary) {
      return { available: false, reason: "No primary provider configured" };
    }
    return this.primary.probeEmbeddingAvailability();
  }

  /**
   * Probe vector availability
   * Delegate to primary provider
   */
  async probeVectorAvailability(): Promise<boolean> {
    if (!this.primary) {
      return false;
    }
    return this.primary.probeVectorAvailability();
  }

  /**
   * Get detailed status
   */
  getStatus(): ChainManagerStatus {
    const providerStats = Array.from(this.providers.values()).map((p) => p.getStats());
    const queueStatus = this.asyncQueue.getStatus();

    return {
      backend: "chain",
      providers: providerStats,
      asyncQueue: queueStatus,
      global: this.config.global,
    };
  }

  /**
   * Close manager
   */
  async close(): Promise<void> {
    // StopHealth Monitor
    this.healthMonitor.stop();

    // Wait for async queue to complete
    await this.asyncQueue.drain();

    // Clear queue
    this.asyncQueue.clear();

    // Close all child providers
    for (const [name, provider] of this.providers) {
      try {
        if (provider.close) {
          await provider.close();
        }
      } catch (error) {
        log.error(`Failed to close provider ${name}:`, error);
      }
    }
  }

  /**
   * Get provider
   */
  getProvider(name: string) {
    return this.providers.get(name);
  }

  /**
   * Get all providers
   */
  getProviders(): ProviderWrapper[] {
    return Array.from(this.providers.values());
  }

  /**
   * Reset providerCircuit Breaker
   */
  resetCircuitBreaker(providerName: string): boolean {
    const provider = this.providers.get(providerName);
    if (!provider) {
      return false;
    }

    provider.resetCircuitBreaker();
    return true;
  }

  /**
   * Get dead letter queue
   */
  getDeadLetterQueue() {
    return this.asyncQueue.getDeadLetterQueue();
  }

  /**
   * RetryItems in dead letter queue
   */
  retryDeadLetter(taskId: string): boolean {
    return this.asyncQueue.retryDeadLetter(taskId);
  }
}
