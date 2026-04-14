/**
 * Resource management utilities for improved stability.
 *
 * This module provides:
 * - Disposable resource patterns with automatic cleanup
 * - Resource pool management
 * - Graceful shutdown coordination
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { withTimeout } from "./error-handling.js";

const log = createSubsystemLogger("resource-mgmt");

export type Disposable = {
  dispose: () => Promise<void> | void;
};

export type DisposableResource<T> = T & Disposable;

/**
 * Registry for tracking and disposing resources during shutdown.
 */
export class ResourceRegistry {
  private resources = new Map<string, Disposable>();
  private disposed = false;

  /**
   * Registers a resource for tracking.
   */
  register(name: string, resource: Disposable): void {
    if (this.disposed) {
      log.warn(`cannot register resource after disposal: ${name}`);
      return;
    }
    if (this.resources.has(name)) {
      log.warn(`resource already registered, replacing: ${name}`);
    }
    this.resources.set(name, resource);
  }

  /**
   * Unregisters a resource.
   */
  unregister(name: string): boolean {
    return this.resources.delete(name);
  }

  /**
   * Checks if a resource is registered.
   */
  has(name: string): boolean {
    return this.resources.has(name);
  }

  /**
   * Gets the count of registered resources.
   */
  get size(): number {
    return this.resources.size;
  }

  /**
   * Disposes all registered resources in reverse registration order.
   */
  async disposeAll(options?: { timeoutMs?: number }): Promise<{
    succeeded: string[];
    failed: Array<{ name: string; error: unknown }>;
  }> {
    if (this.disposed) {
      return { succeeded: [], failed: [] };
    }
    this.disposed = true;

    const succeeded: string[] = [];
    const failed: Array<{ name: string; error: unknown }> = [];
    const entries = Array.from(this.resources.entries()).toReversed();

    for (const [name, resource] of entries) {
      try {
        const disposePromise = Promise.resolve(resource.dispose());
        if (options?.timeoutMs) {
          await withTimeout(() => disposePromise, options.timeoutMs, {
            context: { operation: `dispose:${name}`, subsystem: "resource-mgmt" },
          });
        } else {
          await disposePromise;
        }
        succeeded.push(name);
        log.debug(`disposed resource: ${name}`);
      } catch (error) {
        failed.push({ name, error });
        log.error(`failed to dispose resource: ${name}`);
      }
    }

    this.resources.clear();
    return { succeeded, failed };
  }

  /**
   * Checks if the registry has been disposed.
   */
  get isDisposed(): boolean {
    return this.disposed;
  }
}

/**
 * Creates a scoped resource that is automatically disposed when the scope exits.
 */
export async function withResource<T, R>(
  create: () => Promise<DisposableResource<T>> | DisposableResource<T>,
  use: (resource: T) => Promise<R>,
): Promise<R> {
  const resource = await create();
  try {
    return await use(resource);
  } finally {
    try {
      await resource.dispose();
    } catch (err) {
      log.error(`resource cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * Creates multiple scoped resources that are automatically disposed when the scope exits.
 */
export async function withResources<R>(
  resources: Array<{
    name: string;
    create: () => Promise<Disposable> | Disposable;
  }>,
  use: () => Promise<R>,
): Promise<R> {
  const registry = new ResourceRegistry();

  try {
    for (const { name, create } of resources) {
      const resource = await create();
      registry.register(name, resource);
    }
    return await use();
  } finally {
    const { failed } = await registry.disposeAll();
    if (failed.length > 0) {
      log.warn(`${failed.length} resource(s) failed to dispose`);
    }
  }
}

export type PoolOptions<T> = {
  create: () => Promise<T> | T;
  destroy?: (item: T) => Promise<void> | void;
  validate?: (item: T) => boolean;
  maxSize: number;
  minSize?: number;
  acquireTimeoutMs?: number;
};

/**
 * A generic resource pool for managing expensive resources.
 */
export class ResourcePool<T> implements Disposable {
  private available: T[] = [];
  private inUse = new Set<T>();
  private waitQueue: Array<{
    resolve: (item: T) => void;
    reject: (err: Error) => void;
  }> = [];
  private disposed = false;
  private options: Required<Omit<PoolOptions<T>, "destroy" | "validate">> & {
    destroy?: (item: T) => Promise<void> | void;
    validate?: (item: T) => boolean;
  };

  constructor(options: PoolOptions<T>) {
    this.options = {
      ...options,
      minSize: options.minSize ?? 0,
      acquireTimeoutMs: options.acquireTimeoutMs ?? 30_000,
    };
  }

  /**
   * Acquires a resource from the pool.
   */
  async acquire(): Promise<T> {
    if (this.disposed) {
      throw new Error("Pool has been disposed");
    }

    // Try to get an existing valid resource
    while (this.available.length > 0) {
      const item = this.available.pop()!;
      if (!this.options.validate || this.options.validate(item)) {
        this.inUse.add(item);
        return item;
      }
      // Invalid item, destroy it
      await this.destroyItem(item);
    }

    // Create new if under max
    if (this.inUse.size < this.options.maxSize) {
      const item = await this.options.create();
      this.inUse.add(item);
      return item;
    }

    // Wait for an available resource
    return new Promise((resolve, reject) => {
      // Create waiter object to track for removal on timeout
      const waiter = {
        resolve: (item: T) => {
          clearTimeout(timeoutId);
          resolve(item);
        },
        reject: (err: Error) => {
          clearTimeout(timeoutId);
          reject(err);
        },
      };

      const timeoutId = setTimeout(() => {
        // Remove this specific waiter from the queue on timeout
        const index = this.waitQueue.indexOf(waiter);
        if (index !== -1) {
          this.waitQueue.splice(index, 1);
        }
        reject(new Error(`Acquire timeout after ${this.options.acquireTimeoutMs}ms`));
      }, this.options.acquireTimeoutMs);

      this.waitQueue.push(waiter);
    });
  }

  /**
   * Releases a resource back to the pool.
   */
  release(item: T): void {
    if (!this.inUse.has(item)) {
      return;
    }
    this.inUse.delete(item);

    if (this.disposed) {
      void this.destroyItem(item);
      return;
    }

    // If someone is waiting, give it to them (but validate first)
    const waiter = this.waitQueue.shift();
    if (waiter) {
      if (this.options.validate && !this.options.validate(item)) {
        void this.destroyItem(item);
        waiter.reject(new Error("Released item failed validation"));
        return;
      }
      this.inUse.add(item);
      waiter.resolve(item);
      return;
    }

    // Otherwise return to pool
    if (!this.options.validate || this.options.validate(item)) {
      this.available.push(item);
    } else {
      void this.destroyItem(item);
    }
  }

  /**
   * Gets the current pool statistics.
   */
  get stats(): { available: number; inUse: number; waiting: number } {
    return {
      available: this.available.length,
      inUse: this.inUse.size,
      waiting: this.waitQueue.length,
    };
  }

  /**
   * Disposes the pool and all resources.
   */
  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    // Reject all waiters
    for (const waiter of this.waitQueue) {
      waiter.reject(new Error("Pool disposed"));
    }
    this.waitQueue = [];

    // Destroy all available items
    const destroyPromises = this.available.map((item) => this.destroyItem(item));
    this.available = [];

    // Wait for in-use items would require tracking, so we just log
    if (this.inUse.size > 0) {
      log.warn(`pool disposed with ${this.inUse.size} items still in use`);
    }

    await Promise.allSettled(destroyPromises);
  }

  private async destroyItem(item: T): Promise<void> {
    if (this.options.destroy) {
      try {
        await this.options.destroy(item);
      } catch (err) {
        log.error(
          `failed to destroy pool item: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}

/**
 * Uses a resource from a pool with automatic release.
 */
export async function withPooledResource<T, R>(
  pool: ResourcePool<T>,
  use: (resource: T) => Promise<R>,
): Promise<R> {
  const resource = await pool.acquire();
  try {
    return await use(resource);
  } finally {
    pool.release(resource);
  }
}

export type ShutdownHandler = () => Promise<void> | void;

/**
 * Coordinates graceful shutdown across multiple subsystems.
 */
export class ShutdownCoordinator {
  private handlers = new Map<string, { handler: ShutdownHandler; priority: number }>();
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;

  /**
   * Registers a shutdown handler.
   * Lower priority numbers run first.
   */
  register(name: string, handler: ShutdownHandler, priority = 100): () => void {
    if (this.shuttingDown) {
      log.warn(`cannot register shutdown handler during shutdown: ${name}`);
      return () => {};
    }
    this.handlers.set(name, { handler, priority });
    return () => this.handlers.delete(name);
  }

  /**
   * Initiates graceful shutdown.
   */
  async shutdown(options?: { timeoutMs?: number }): Promise<{
    succeeded: string[];
    failed: Array<{ name: string; error: unknown }>;
  }> {
    if (this.shutdownPromise) {
      await this.shutdownPromise;
      return { succeeded: [], failed: [] };
    }

    this.shuttingDown = true;
    const succeeded: string[] = [];
    const failed: Array<{ name: string; error: unknown }> = [];

    // Sort by priority (ascending)
    const sorted = Array.from(this.handlers.entries()).toSorted(
      ([, a], [, b]) => a.priority - b.priority,
    );

    this.shutdownPromise = (async () => {
      for (const [name, { handler }] of sorted) {
        try {
          log.info(`shutting down: ${name}`);
          const handlerPromise = Promise.resolve(handler());
          if (options?.timeoutMs) {
            await withTimeout(() => handlerPromise, options.timeoutMs, {
              context: { operation: `shutdown:${name}`, subsystem: "shutdown" },
            });
          } else {
            await handlerPromise;
          }
          succeeded.push(name);
        } catch (error) {
          failed.push({ name, error });
          log.error(`shutdown handler failed: ${name}`);
        }
      }
      this.handlers.clear();
    })();

    await this.shutdownPromise;
    return { succeeded, failed };
  }

  /**
   * Checks if shutdown is in progress.
   */
  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }
}

/**
 * Global shutdown coordinator instance.
 */
export const globalShutdownCoordinator = new ShutdownCoordinator();
