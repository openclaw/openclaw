export type CommandQueueEnqueueOptions = {
  warnAfterMs?: number;
  onWait?: (waitMs: number, queuedAhead: number) => void;
  taskTimeoutMs?: number;
  taskTimeoutProgressAtMs?: () => number | undefined;
};

export type CommandQueueEnqueueFn = <T>(
  task: () => Promise<T>,
  opts?: CommandQueueEnqueueOptions,
) => Promise<T>;
