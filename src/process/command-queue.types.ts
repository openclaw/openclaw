export const CommandPriority = {
  Low: 0,
  Normal: 1,
  High: 2,
} as const;

export type CommandPriority = (typeof CommandPriority)[keyof typeof CommandPriority];

export type CommandQueueEnqueueOptions = {
  priority?: CommandPriority;
  warnAfterMs?: number;
  onWait?: (waitMs: number, queuedAhead: number) => void;
  taskTimeoutMs?: number;
};

export type CommandQueueEnqueueFn = <T>(
  task: () => Promise<T>,
  opts?: CommandQueueEnqueueOptions,
) => Promise<T>;
