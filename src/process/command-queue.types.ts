export type CommandQueueEnqueueOptions = {
  warnAfterMs?: number;
  onWait?: (waitMs: number, queuedAhead: number) => void;
  taskTimeoutMs?: number;
  priority?: import("./lanes.js").CommandPriority;
};

export type CommandQueueEnqueueFn = <T>(
  task: () => Promise<T>,
  opts?: CommandQueueEnqueueOptions,
) => Promise<T>;
