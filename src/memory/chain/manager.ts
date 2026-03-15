/**
 * Chain Memory Backend - Chain Memory Manager
 *
 * Coordinate multiple providers with fault isolation and degradation
 *
 * @module manager
 * @author Tutu
 * @date 2026-03-09
 */

import { validateChainConfig } from "../../config-validator.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type {
  MemorySearchManager,
  MemorySearchResult,
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
} from "../types.js";
import { HealthMonitor } from "./health-monitor.js";
import type {
  ChainConfig,
  ProviderWrapper,
  ChainManagerStatus,
  ChainManagerOptions,
} from "./types.js";
import { ProviderWrapper as ProviderWrapperClass } from "./wrapper.js";

const log = createSubsystemLogger("chain-memory");

/**
 * Chain Memory Manager
 *
 * Implement multi-provider coordination with fault isolation and degradation.
 * Use ChainMemoryManager.create() to initialize.
 */
export class ChainMemoryManager implements MemorySearchManager {
  private config: ChainConfig;
  private providers: Map<string, ProviderWrapperClass> = new Map();
  private primary?: ProviderWrapperClass;
  private secondary: ProviderWrapperClass[] = [];
  private fallback?: ProviderWrapperClass;
  private healthMonitor: HealthMonitor;

  /**
   * Private constructor - use create() factory method instead
   */
  private constructor(config: ChainConfig) {
    this.config = config;

    // Initialize health monitor
    this.healthMonitor = new HealthMonitor({
      checkIntervalMs: this.config.global.healthCheckInterval,
      timeoutMs: this.config.global.defaultTimeout,
    });
  }

  /**
   * Factory method to create and initialize ChainMemoryManager
   */
  static async create(options: ChainManagerOptions): Promise<ChainMemoryManager> {
    // Validate configuration
    const validated = validateChainConfig(options.config);
    const config: ChainConfig = {
      providers: validated.providers,
      global: validated.global,
    };

    const manager = new ChainMemoryManager(config);

    // Initialize providers asynchronously
    await manager.initializeProviders(options);

    // Start health monitor
    manager.healthMonitor.start();

    return manager;
  }

  /**
   * Initialize providers asynchronously
   */
  private async initializeProviders(options: ChainManagerOptions): Promise<void> {
    for (const providerConfig of this.config.providers) {
      // Skip disabled provider
      if (providerConfig.enabled === false) {
        log.info(`Skipping disabled provider: ${providerConfig.name}`);
        continue;
      }

      let manager: MemorySearchManager;

      try {
        if (providerConfig.backend) {
          // Use backend factory
          manager = await options.getBackendManager(providerConfig.backend, providerConfig);
        } else if (providerConfig.plugin) {
          // Use plugin factory
          if (!options.getPluginManager) {
            throw new Error(
              `getPluginManager not provided but plugin '${providerConfig.plugin}' ` +
                `specified for provider '${providerConfig.name}'`,
            );
          }
          manager = await options.getPluginManager(providerConfig.plugin, providerConfig);
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

        // Register to health monitor
        this.healthMonitor.registerProvider(wrapper);

        // Classify by priority
        if (providerConfig.priority === "primary") {
          this.primary = wrapper;
        } else if (providerConfig.priority === "secondary") {
          this.secondary.push(wrapper);
        } else if (providerConfig.priority === "fallback") {
          this.fallback = wrapper;
        }

        log.info(`Initialized provider: ${providerConfig.name} (${providerConfig.priority})`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error(`Failed to initialize provider '${providerConfig.name}': ${message}`);

        // If this is the primary provider, rethrow the error
        if (providerConfig.priority === "primary") {
          throw new Error(
            `Failed to initialize primary provider '${providerConfig.name}': ${message}`,
            { cause: error },
          );
        }
        // For non-primary providers, log and continue
        // They will be marked as unavailable
      }
    }
  }

  /**
   * Search memory with automatic fallback
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
        log.warn(
          `Primary search failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Try secondary providers in order
    for (const provider of this.secondary) {
      if (provider.isAvailable()) {
        try {
          return await provider.search(query, options);
        } catch (error) {
          log.warn(
            `Secondary ${provider.config.name} search failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    // Try fallback
    if (this.config.global.enableFallback && this.fallback && this.fallback.isAvailable()) {
      try {
        return await this.fallback.search(query, options);
      } catch (error) {
        log.warn(
          `Fallback search failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // All providers failed, return empty results
    log.warn("All providers failed for search operation");
    return [];
  }

  /**
   * Read file with automatic fallback
   */
  async readFile(options: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ path: string; text: string }> {
    // Try primary
    if (this.primary && this.primary.isAvailable()) {
      try {
        return await this.primary.readFile(options);
      } catch (error) {
        log.warn(
          `Primary readFile failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Try secondary providers
    for (const provider of this.secondary) {
      if (provider.isAvailable()) {
        try {
          return await provider.readFile(options);
        } catch (error) {
          log.warn(
            `Secondary ${provider.config.name} readFile failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    // Try fallback
    if (this.config.global.enableFallback && this.fallback && this.fallback.isAvailable()) {
      try {
        return await this.fallback.readFile(options);
      } catch (error) {
        log.warn(
          `Fallback readFile failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    throw new Error("No available provider for readFile");
  }

  /**
   * Get status
   */
  status(): MemoryProviderStatus {
    const providerStats = Array.from(this.providers.values()).map((p) => p.getStats());

    // Convert Map to plain object for JSON serialization (P2 fix)
    const healthMap = this.healthMonitor.getHealthStatus();
    const healthObj: Record<string, string> = {};
    healthMap.forEach((status, name) => {
      healthObj[name] = status;
    });

    return {
      backend: "chain",
      provider: "chain",
      model: "multi-provider",
      fallback: this.fallback?.config.name
        ? { from: this.fallback.config.name, reason: "Configured as fallback provider" }
        : undefined,
      custom: {
        providers: providerStats,
        health: healthObj,
      },
    };
  }

  /**
   * Probe embedding availability with fallback
   */
  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    // Try primary
    if (this.primary && this.primary.isAvailable()) {
      try {
        const result = await this.primary.probeEmbeddingAvailability();
        if (result.ok) {
          return result;
        }
      } catch (error) {
        log.warn(
          `Primary probeEmbeddingAvailability failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Try secondary providers
    for (const provider of this.secondary) {
      if (provider.isAvailable()) {
        try {
          const result = await provider.probeEmbeddingAvailability();
          if (result.ok) {
            return result;
          }
        } catch (error) {
          log.warn(
            `Secondary ${provider.config.name} probeEmbeddingAvailability failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    // Try fallback
    if (this.config.global.enableFallback && this.fallback && this.fallback.isAvailable()) {
      try {
        const result = await this.fallback.probeEmbeddingAvailability();
        if (result.ok) {
          return result;
        }
      } catch (error) {
        log.warn(
          `Fallback probeEmbeddingAvailability failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // All providers failed
    return { ok: false, error: "No provider with embedding capability available" };
  }

  /**
   * Probe vector availability with fallback
   */
  async probeVectorAvailability(): Promise<boolean> {
    // Try primary
    if (this.primary && this.primary.isAvailable()) {
      try {
        if (await this.primary.probeVectorAvailability()) {
          return true;
        }
      } catch (error) {
        log.warn(
          `Primary probeVectorAvailability failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // Try secondary providers
    for (const provider of this.secondary) {
      if (provider.isAvailable()) {
        try {
          if (await provider.probeVectorAvailability()) {
            return true;
          }
        } catch (error) {
          log.warn(
            `Secondary ${provider.config.name} probeVectorAvailability failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    // Try fallback
    if (this.config.global.enableFallback && this.fallback && this.fallback.isAvailable()) {
      try {
        if (await this.fallback.probeVectorAvailability()) {
          return true;
        }
      } catch (error) {
        log.warn(
          `Fallback probeVectorAvailability failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return false;
  }

  /**
   * Get detailed status
   */
  getStatus(): ChainManagerStatus {
    const providerStats = Array.from(this.providers.values()).map((p) => p.getStats());

    return {
      backend: "chain",
      providers: providerStats,
      global: this.config.global,
    };
  }

  /**
   * Close manager
   */
  async close(): Promise<void> {
    // Stop health monitor
    this.healthMonitor.stop();

    // Close all child providers
    for (const [name, provider] of this.providers) {
      try {
        if (provider.close) {
          await provider.close();
        }
      } catch (error) {
        log.error(
          `Failed to close provider ${name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * Get provider by name
   */
  getProvider(name: string): ProviderWrapperClass | undefined {
    return this.providers.get(name);
  }

  /**
   * Get all providers
   */
  getProviders(): ProviderWrapper[] {
    return Array.from(this.providers.values());
  }

  /**
   * Reset provider circuit breaker
   */
  resetCircuitBreaker(providerName: string): boolean {
    const provider = this.providers.get(providerName);
    if (!provider) {
      return false;
    }

    provider.resetCircuitBreaker();
    return true;
  }
}
