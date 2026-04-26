export type CommandQueueEnqueueFn = <T>(
  task: () => Promise<T>,
  opts?: {
    warnAfterMs?: number;
    onWait?: (waitMs: number, queuedAhead: number) => void;
    /** Max active execution time in ms. 0 or Infinity disables the lane fallback timeout. */
    taskTimeoutMs?: number;
  },
) => Promise<T>;
