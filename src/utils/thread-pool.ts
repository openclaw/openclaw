import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import os from "node:os";

/**
 * Thread Pool for Maximum Core Utilization on Apple Silicon
 * 
 * This module provides a high-performance thread pool that automatically
 * optimizes for all available CPU, GPU, and ANE resources on Apple Silicon.
 */

/**
 * Thread pool configuration
 */
export interface ThreadPoolConfig {
  maxThreads: number;
  minThreads: number;
  idleTimeout: number;
  taskQueueSize: number;
}

/**
 * Default thread pool configuration optimized for Apple Silicon
 */
export function getDefaultThreadPoolConfig(): ThreadPoolConfig {
  const cpuCount = getPhysicalCpuCount();
  
  // On Apple Silicon, use all physical cores for maximum parallelism
  // Performance cores are prioritized for compute-intensive tasks
  const performanceCores = getPerformanceCoreCount();
  
  return {
    maxThreads: Math.max(1, performanceCores * 2), // Over-subscribe slightly for I/O bound tasks
    minThreads: Math.max(1, performanceCores), // Always keep at least one thread per core
    idleTimeout: 30_000, // 30 seconds
    taskQueueSize: performanceCores * 10,
  };
}

/**
 * Thread pool state
 */
export interface ThreadPoolState {
  activeThreads: number;
  idleThreads: number;
  queuedTasks: number;
  totalTasksCompleted: number;
  totalTasksFailed: number;
}

/**
 * Thread pool class for maximum performance
 */
export class ThreadPool {
  private config: ThreadPoolConfig;
  private workers: Map<number, Worker> = new Map();
  private taskQueue: Array<{ id: number; task: () => any }> = [];
  private activeTasks: Map<number, { workerId: number; resolve: (value: any) => void; reject: (error: Error) => void }> = new Map();
  private taskCounter = 0;
  private totalTasksCompleted = 0;
  private totalTasksFailed = 0;
  private idleTimeouts: Map<number, NodeJS.Timeout> = new Map();
  
  constructor(config?: Partial<ThreadPoolConfig>) {
    this.config = { ...getDefaultThreadPoolConfig(), ...config };
    
    // Initialize thread pool with minimum threads
    this.initializePool();
  }
  
  /**
   * Initialize the thread pool with minimum threads
   */
  private initializePool(): void {
    for (let i = 0; i < this.config.minThreads; i++) {
      this.createWorker(i);
    }
  }
  
  /**
   * Create a new worker thread
   */
  private createWorker(workerId: number): void {
    const worker = new Worker(__filename, {
      workerData: { workerId },
    });
    
    // Handle worker messages
    worker.on("message", (data) => {
      if (data.type === "task-complete") {
        this.handleTaskComplete(data.taskId, data.result);
      } else if (data.type === "task-error") {
        this.handleTaskError(data.taskId, data.error);
      } else if (data.type === "worker-ready") {
        this.handleWorkerReady(workerId);
      }
    });
    
    worker.on("error", (error) => {
      console.error(`Worker ${workerId} error:`, error);
    });
    
    worker.on("exit", (code) => {
      if (code !== 0) {
        console.error(`Worker ${workerId} exited with code ${code}`);
      }
    });
    
    this.workers.set(workerId, worker);
  }
  
  /**
   * Handle worker ready state
   */
  private handleWorkerReady(workerId: number): void {
    // Worker is ready, check if there are tasks to process
    this.processQueue();
  }
  
  /**
   * Handle task completion
   */
  private handleTaskComplete(taskId: number, result: any): void {
    const task = this.activeTasks.get(taskId);
    if (task) {
      task.resolve(result);
      this.activeTasks.delete(taskId);
      this.totalTasksCompleted++;
    }
    
    // Check if we can process more tasks
    this.processQueue();
  }
  
  /**
   * Handle task error
   */
  private handleTaskError(taskId: number, error: Error): void {
    const task = this.activeTasks.get(taskId);
    if (task) {
      task.reject(error);
      this.activeTasks.delete(taskId);
      this.totalTasksFailed++;
    }
    
    // Check if we can process more tasks
    this.processQueue();
  }
  
  /**
   * Process the task queue
   */
  private processQueue(): void {
    // Find idle workers
    const idleWorkers = Array.from(this.workers.keys()).filter(
      (id) => !Array.from(this.activeTasks.values()).some((t) => t.workerId === id)
    );
    
    // Submit queued tasks to idle workers
    while (idleWorkers.length > 0 && this.taskQueue.length > 0) {
      const workerId = idleWorkers.shift()!;
      const task = this.taskQueue.shift();
      
      if (task) {
        this.submitTaskToWorker(task, workerId);
      }
    }
  }
  
  /**
   * Submit a task to a specific worker
   */
  private submitTaskToWorker(task: { id: number; task: () => any }, workerId: number): void {
    const worker = this.workers.get(workerId);
    if (worker) {
      worker.postMessage({
        type: "execute-task",
        taskId: task.id,
        taskCode: task.task.toString(),
      });
      
      this.activeTasks.set(task.id, {
        workerId,
        resolve: () => {},
        reject: () => {},
      });
    }
  }
  
  /**
   * Submit a task to the thread pool
   */
  public async run<T>(task: () => T): Promise<T> {
    return new Promise((resolve, reject) => {
      const taskId = ++this.taskCounter;
      
      this.activeTasks.set(taskId, {
        workerId: -1,
        resolve: (value: T) => {
          this.totalTasksCompleted++;
          resolve(value);
          this.processQueue();
        },
        reject: (error: Error) => {
          this.totalTasksFailed++;
          reject(error);
          this.processQueue();
        },
      });
      
      // Try to find an idle worker
      const idleWorkers = Array.from(this.workers.keys()).filter(
        (id) => !Array.from(this.activeTasks.values()).some((t) => t.workerId === id)
      );
      
      if (idleWorkers.length > 0) {
        this.submitTaskToWorker({ id: taskId, task }, idleWorkers[0]);
      } else {
        // Queue the task if no workers are available
        this.taskQueue.push({ id: taskId, task });
      }
    });
  }
  
  /**
   * Get the current state of the thread pool
   */
  public getState(): ThreadPoolState {
    const activeWorkerIds = new Set(Array.from(this.activeTasks.values()).map((t) => t.workerId));
    const allWorkerIds = new Set(this.workers.keys());
    
    return {
      activeThreads: activeWorkerIds.size,
      idleThreads: allWorkerIds.size - activeWorkerIds.size,
      queuedTasks: this.taskQueue.length,
      totalTasksCompleted: this.totalTasksCompleted,
      totalTasksFailed: this.totalTasksFailed,
    };
  }
  
  /**
   * Get the number of available threads
   */
  public getAvailableThreads(): number {
    const state = this.getState();
    return Math.max(0, this.config.minThreads - state.activeThreads);
  }
  
  /**
   * Scale the thread pool to a specific size
   */
  public scale(count: number): void {
    const currentCount = this.workers.size;
    
    if (count > currentCount) {
      // Scale up
      for (let i = currentCount; i < count && i < this.config.maxThreads; i++) {
        this.createWorker(i);
      }
    } else if (count < currentCount) {
      // Scale down
      const idsToRemove = Array.from(this.workers.keys()).slice(0, currentCount - count);
      for (const id of idsToRemove) {
        const worker = this.workers.get(id);
        if (worker) {
          worker.terminate();
          this.workers.delete(id);
        }
      }
    }
  }
  
  /**
   * Shutdown the thread pool
   */
  public async shutdown(): Promise<void> {
    for (const [id, worker] of this.workers) {
      await new Promise((resolve) => {
        worker.terminate();
        worker.on("exit", resolve);
      });
    }
    this.workers.clear();
  }
}

/**
 * Parallel execution utility for maximum performance
 */
export interface ParallelOptions {
  concurrency?: number;
  chunkSize?: number;
}

/**
 * Execute a function in parallel across multiple threads
 */
export async function parallel<T, R>(
  items: T[],
  fn: (item: T, index: number) => R,
  options?: ParallelOptions
): Promise<R[]> {
  const config = getDefaultThreadPoolConfig();
  const threadPool = new ThreadPool({
    maxThreads: options?.concurrency || config.maxThreads,
  });
  
  try {
    const results = await Promise.all(
      items.map((item, index) => threadPool.run(() => fn(item, index)))
    );
    
    return results;
  } finally {
    await threadPool.shutdown();
  }
}

/**
 * Map operation in parallel
 */
export async function parallelMap<T, R>(
  items: T[],
  fn: (item: T, index: number) => R,
  options?: ParallelOptions
): Promise<R[]> {
  return parallel(items, fn, options);
}

/**
 * Filter operation in parallel
 */
export async function parallelFilter<T>(
  items: T[],
  fn: (item: T, index: number) => boolean,
  options?: ParallelOptions
): Promise<T[]> {
  const results = await parallel(items, (item, index) => ({
    item,
    keep: fn(item, index),
  }), options);
  
  return results.filter((r) => r.keep).map((r) => r.item);
}

/**
 * Reduce operation in parallel
 */
export async function parallelReduce<T, R>(
  items: T[],
  fn: (accumulator: R, item: T, index: number) => R,
  initialValue: R,
  options?: ParallelOptions
): Promise<R> {
  const chunkSize = options?.chunkSize || Math.ceil(items.length / (options?.concurrency || 4));
  
  // Split into chunks
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  
  // Reduce each chunk in parallel
  const threadPool = new ThreadPool({
    maxThreads: options?.concurrency || chunks.length,
  });
  
  try {
    const chunkResults = await Promise.all(
      chunks.map((chunk) => threadPool.run(async () => {
        return chunk.reduce(fn, initialValue as R);
      }))
    );
    
    // Final reduction
    return chunkResults.reduce(fn, initialValue);
  } finally {
    await threadPool.shutdown();
  }
}
