/**
 * Public enqueue knobs shared by command-lane callers and narrower injection
 * points that should not import the full queue implementation.
 */
export type CommandQueueWaitInfo = {
  lane: string;
  waitedMs: number;
  warnAfterMs: number;
  queueAhead: number;
  activeAhead: number;
  activeNow: number;
  queueBehind: number;
};

export type CommandQueueEnqueueOptions = {
  warnAfterMs?: number;
  onWait?: (waitMs: number, queuedAhead: number, info: CommandQueueWaitInfo) => void;
  rejectOnWait?: (info: CommandQueueWaitInfo) => unknown;
  taskTimeoutMs?: number;
  taskTimeoutProgressAtMs?: () => number | undefined;
  priority?: "foreground" | "normal" | "background";
};

/** Minimal queue function contract used by code that only needs to schedule work. */
export type CommandQueueEnqueueFn = <T>(
  task: () => Promise<T>,
  opts?: CommandQueueEnqueueOptions,
) => Promise<T>;
