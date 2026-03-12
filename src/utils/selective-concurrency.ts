import { createAsyncLock } from "./async-lock";

// Types for operation classifications
export type OperationType = "read" | "write" | "io" | "compute" | "network";
export type ConcurrencyLimits = {
  [key in OperationType]?: number;
} & { default: number };

// Type for the operation to be executed
export type Operation<T = unknown> = {
  id?: string;
  type: OperationType;
  fn: () => Promise<T>;
  priority?: number; // Higher priority gets executed first (0 = highest)
  dependencies?: string[]; // Operation IDs this operation depends on
};

// Represents a pending operation
type PendingOperation<T = unknown> = {
  op: Operation<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

/**
 * SelectiveConcurrencyManager allows different operation types to run with
 * different concurrency limits based on their classification (read vs write, etc.)
 */
class SelectiveConcurrencyManager {
  private static instance: SelectiveConcurrencyManager;

  // Separate queues for each operation type
  private queues: Map<OperationType, PendingOperation[]> = new Map();

  // Currently running operations per type
  private running: Map<OperationType, number> = new Map();

  // Locks for each operation type to control access to queues
  private typeLocks: Map<OperationType, ReturnType<typeof createAsyncLock>> = new Map();

  // Operation ID tracking
  private activeOperations: Map<string, OperationType> = new Map();

  // Default concurrency limits
  private limits: ConcurrencyLimits = {
    read: 8, // High concurrency for read operations
    write: 2, // Lower concurrency for write operations
    io: 4, // Moderate concurrency for I/O operations
    compute: 4, // Moderate concurrency for CPU-intensive operations
    network: 6, // Higher concurrency for network operations
    default: 1, // Conservative default
  };

  private constructor() {
    // Initialize locks for each operation type
    const allTypes: OperationType[] = ["read", "write", "io", "compute", "network"];
    for (const type of allTypes) {
      this.typeLocks.set(type, createAsyncLock());
      this.queues.set(type, []);
      this.running.set(type, 0);
    }
  }

  public static getInstance(): SelectiveConcurrencyManager {
    if (!SelectiveConcurrencyManager.instance) {
      SelectiveConcurrencyManager.instance = new SelectiveConcurrencyManager();
    }
    return SelectiveConcurrencyManager.instance;
  }

  /**
   * Sets concurrency limits for operation types
   * @param limits The concurrency limits to set
   */
  setLimits(limits: Partial<ConcurrencyLimits>): void {
    this.limits = { ...this.limits, ...limits };
  }

  /**
   * Gets the current concurrency limit for an operation type
   * @param type The operation type
   * @returns The concurrency limit
   */
  getLimit(type: OperationType): number {
    return this.limits[type] ?? this.limits.default;
  }

  /**
   * Executes an operation based on its type with appropriate concurrency limits
   * @param operation The operation to execute
   * @returns Promise that resolves to the operation result
   */
  async execute<T>(operation: Operation<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const opType = operation.type;

      // Add operation to the appropriate queue
      const queue = this.queues.get(opType) || [];
      queue.push({ op: operation, resolve, reject });
      this.queues.set(opType, queue);

      // Attempt to process the queue
      void this.processQueue(opType);
    });
  }

  /**
   * Processes the queue for a specific operation type
   * @param type The operation type to process
   */
  private async processQueue(type: OperationType): Promise<void> {
    // Use the type-specific lock to prevent concurrent queue processing
    const lock = this.typeLocks.get(type);
    if (!lock) {
      return;
    }

    await lock(async () => {
      const queue = this.queues.get(type) || [];
      const runningCount = this.running.get(type) || 0;
      const limit = this.getLimit(type);

      // Process operations while we have capacity and work available
      while (runningCount < limit && queue.length > 0) {
        // Find next eligible operation (one without unsatisfied dependencies)
        const nextOpIndex = this.findNextEligibleOperation(queue);

        if (nextOpIndex !== -1) {
          const nextOp = queue.splice(nextOpIndex, 1)[0];

          // Update running count
          const currentRunning = this.running.get(type) || 0;
          this.running.set(type, currentRunning + 1);

          // Track the operation if it has an ID
          if (nextOp.op.id) {
            this.activeOperations.set(nextOp.op.id, type);
          }

          // Execute the operation asynchronously
          void this.executeOperation(nextOp, type);
        } else {
          // No eligible operations available, break the loop
          break;
        }
      }

      // Update the queue after processing
      this.queues.set(type, queue);
    });
  }

  /**
   * Finds the next operation in the queue that has satisfied dependencies
   * @param queue The queue to search
   * @returns Index of the next eligible operation, or -1 if none found
   */
  private findNextEligibleOperation(queue: PendingOperation[]): number {
    for (let i = 0; i < queue.length; i++) {
      const op = queue[i].op;

      // If no dependencies, it's eligible
      if (!op.dependencies || op.dependencies.length === 0) {
        return i;
      }

      // Check if all dependencies are satisfied
      const allSatisfied = op.dependencies.every((depId) => {
        // A dependency is satisfied if it's not in the active operations map
        return !this.activeOperations.has(depId);
      });

      if (allSatisfied) {
        return i;
      }
    }

    return -1;
  }

  /**
   * Executes a single operation and handles completion
   * @param pendingOp The pending operation to execute
   * @param type The operation type
   */
  private async executeOperation(pendingOp: PendingOperation, type: OperationType): Promise<void> {
    try {
      const result = await pendingOp.op.fn();
      pendingOp.resolve(result);
    } catch (error) {
      pendingOp.reject(error);
    } finally {
      // Decrement running counter
      const currentRunning = this.running.get(type) || 0;
      this.running.set(type, Math.max(0, currentRunning - 1));

      // Remove from active operations if it has an ID
      if (pendingOp.op.id) {
        this.activeOperations.delete(pendingOp.op.id);
      }

      // Process the queue again as we may have freed up capacity
      setTimeout(() => this.processQueue(type), 0);
    }
  }

  /**
   * Gets statistics about the current state
   * @returns Statistics about the queues and running operations
   */
  getStats() {
    const stats: Record<OperationType, { queueLength: number; running: number; limit: number }> = {
      read: { queueLength: 0, running: 0, limit: 0 },
      write: { queueLength: 0, running: 0, limit: 0 },
      io: { queueLength: 0, running: 0, limit: 0 },
      compute: { queueLength: 0, running: 0, limit: 0 },
      network: { queueLength: 0, running: 0, limit: 0 },
    };

    for (const [type, queue] of this.queues.entries()) {
      stats[type] = {
        queueLength: queue.length,
        running: this.running.get(type) || 0,
        limit: this.getLimit(type),
      };
    }

    return stats;
  }

  /**
   * Clears all queues (does not cancel currently running operations)
   */
  clearAllQueues(): void {
    for (const [type] of this.queues.entries()) {
      this.queues.set(type, []);
    }
  }
}

export const selectiveConcurrency = SelectiveConcurrencyManager.getInstance();

/**
 * Helper function to execute an operation with selective concurrency
 * @param op The operation to execute
 * @returns Promise that resolves to the operation result
 */
export async function executeWithSelectiveConcurrency<T>(op: Operation<T>): Promise<T> {
  return await selectiveConcurrency.execute<T>(op);
}

/**
 * Helper function to execute multiple operations with selective concurrency
 * @param ops The operations to execute
 * @returns Promise that resolves to an array of results
 */
export async function executeMultipleWithSelectiveConcurrency<T>(
  ops: Operation<T>[],
): Promise<(T | Error)[]> {
  const promises = ops.map((op) =>
    executeWithSelectiveConcurrency(op).catch((err) => err as Error),
  );

  return await Promise.all(promises);
}
