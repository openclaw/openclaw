/**
 * Chain Memory Backend - Chain Memory Manager
 *
 * 协调多个 provider，实现故障隔离和降级
 *
 * @module manager
 * @author Tutu
 * @date 2026-03-09
 */

import type { MemorySearchManager, MemorySearchResult } from "../../types";
import { validateChainConfig } from "../config-validator";
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
 * 实现多 provider 协调，故障隔离和降级
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
  private getPluginManager?: (plugin: string, config?: unknown) => MemorySearchManager; // 新增

  constructor(options: ChainManagerOptions) {
    // 验证配置
    const validated = validateChainConfig(options.config);
    this.config = {
      providers: validated.providers,
      global: validated.global,
    };

    this.getBackendManager = options.getBackendManager;
    this.getPluginManager = options.getPluginManager; // 新增

    // 初始化异步队列
    this.asyncQueue = new AsyncWriteQueue({
      maxConcurrent: 10,
      retryDelayMs: 1000,
      maxRetries: 3,
    });

    // 设置队列处理器
    this.asyncQueue.setProcessor(async (task) => {
      const provider = this.providers.get(task.providerName);
      if (!provider) {
        throw new Error(`Provider ${task.providerName} not found`);
      }

      // 执行写入操作（这里需要扩展 MemorySearchManager 接口）
      // 暂时使用搜索操作作为占位符
      await provider.search(task.data);
    });

    // 初始化健康监控
    this.healthMonitor = new HealthMonitor({
      checkIntervalMs: this.config.global.healthCheckInterval,
      timeoutMs: this.config.global.defaultTimeout,
    });

    // 初始化 providers
    this.initializeProviders();

    // 启动健康监控
    this.healthMonitor.start();
  }

  /**
   * 初始化 providers
   */
  private initializeProviders(): void {
    for (const providerConfig of this.config.providers) {
      // 跳过禁用的 provider
      if (providerConfig.enabled === false) {
        continue;
      }

      // 获取底层 manager（支持 backend 或 plugin）
      let manager: MemorySearchManager;

      if (providerConfig.backend) {
        // 使用 backend
        manager = this.getBackendManager(providerConfig.backend, providerConfig);
      } else if (providerConfig.plugin) {
        // 使用 plugin
        if (!this.getPluginManager) {
          throw new Error(
            `getPluginManager not provided but plugin '${providerConfig.plugin}' specified for provider '${providerConfig.name}'`,
          );
        }
        manager = this.getPluginManager(providerConfig.plugin, providerConfig);
      } else {
        // 理论上不会发生（config-validator 已经验证）
        throw new Error(
          `Either backend or plugin must be specified for provider '${providerConfig.name}'`,
        );
      }

      // 创建 wrapper
      const wrapper = new ProviderWrapperClass(providerConfig, manager);

      // 注册到 map
      this.providers.set(providerConfig.name, wrapper);

      // 注册到健康监控
      this.healthMonitor.registerProvider(wrapper);

      // 根据 priority 分类
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
   * 搜索记忆
   */
  async search(
    query: string,
    options?: { maxResults?: number; minScore?: number; sessionKey?: string },
  ): Promise<MemorySearchResult[]> {
    // 尝试 primary
    if (this.primary && this.primary.isAvailable()) {
      try {
        return await this.primary.search(query, options);
      } catch (error) {
        // Primary 失败，尝试降级
        console.error(`Primary search failed:`, error);
      }
    }

    // 尝试 secondary
    for (const provider of this.secondary) {
      if (provider.isAvailable()) {
        try {
          return await provider.search(query, options);
        } catch (error) {
          console.error(`Secondary ${provider.config.name} search failed:`, error);
        }
      }
    }

    // 尝试 fallback
    if (this.config.global.enableFallback && this.fallback && this.fallback.isAvailable()) {
      try {
        return await this.fallback.search(query, options);
      } catch (error) {
        console.error(`Fallback search failed:`, error);
      }
    }

    // 所有都失败，返回空
    return [];
  }

  /**
   * 读取文件
   */
  async readFile(options: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ path: string; text: string }> {
    // 尝试 primary
    if (this.primary && this.primary.isAvailable()) {
      try {
        return await this.primary.manager.readFile(options);
      } catch (error) {
        console.error(`Primary readFile failed:`, error);
      }
    }

    // 尝试 fallback
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
   * 获取状态
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
   * 获取详细状态
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
   * 关闭 manager
   */
  async close(): Promise<void> {
    // 停止健康监控
    this.healthMonitor.stop();

    // 等待异步队列完成
    await this.asyncQueue.drain();

    // 清空队列
    this.asyncQueue.clear();
  }

  /**
   * 获取 provider
   */
  getProvider(name: string) {
    return this.providers.get(name);
  }

  /**
   * 获取所有 providers
   */
  getProviders(): ProviderWrapper[] {
    return Array.from(this.providers.values());
  }

  /**
   * 重置 provider 的熔断器
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
   * 获取死信队列
   */
  getDeadLetterQueue() {
    return this.asyncQueue.getDeadLetterQueue();
  }

  /**
   * 重试死信队列中的项
   */
  retryDeadLetter(taskId: string): boolean {
    return this.asyncQueue.retryDeadLetter(taskId);
  }
}
