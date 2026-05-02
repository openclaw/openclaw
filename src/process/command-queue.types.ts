export type CommandQueueEnqueueOptions = {
  warnAfterMs?: number;
  onWait?: (waitMs: number, queuedAhead: number) => void;
  taskTimeoutMs?: number;
  /** Queue priority. Higher values dequeued first. Default 0. */
  priority?: number;
  /**
   * Maximum tasks (queued + active) before circuit breaker rejects new enqueues
   * with CommandLaneCircuitBreakerError. Omit to disable depth-based tripping.
   */
  circuitBreakerDepth?: number;
  /**
   * Maximum ms the oldest queued entry may wait before circuit breaker trips.
   * Omit to disable wait-time-based tripping.
   */
  circuitBreakerWaitMs?: number;
};

export type CommandQueueEnqueueFn = <T>(
  task: () => Promise<T>,
  opts?: CommandQueueEnqueueOptions,
) => Promise<T>;
